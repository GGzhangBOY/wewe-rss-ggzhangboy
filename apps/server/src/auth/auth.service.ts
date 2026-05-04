import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@server/prisma/prisma.service';
import { ConfigurationType } from '@server/configuration';
import { Request } from 'express';
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(scryptCallback);

export const sessionCookieName = 'wewe_rss_session';

export type AuthUser = {
  id: string;
  username: string;
  role: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async login(username: string, password: string) {
    const configuredUsername = this.getAdminUsername();
    const configuredPassword = this.getAdminPassword();

    if (username === configuredUsername) {
      await this.ensureAdminUser(configuredUsername, configuredPassword);
    }

    const user = await this.prismaService.user.findUnique({
      where: { username },
    });

    if (!user || !(await this.verifyPassword(password, user.passwordHash))) {
      throw new Error('Invalid username or password');
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.getSessionExpiresAt();

    await this.prismaService.session.create({
      data: {
        id: randomUUID(),
        tokenHash: this.hashToken(token),
        userId: user.id,
        expiresAt,
      },
    });

    return {
      token,
      expiresAt,
      user: this.toAuthUser(user),
    };
  }

  async logout(token: string) {
    await this.prismaService.session.deleteMany({
      where: {
        tokenHash: this.hashToken(token),
      },
    });
  }

  async getUserFromSessionToken(token: string | undefined) {
    if (!token) {
      return null;
    }

    const session = await this.prismaService.session.findUnique({
      where: {
        tokenHash: this.hashToken(token),
      },
      include: {
        user: true,
      },
    });

    if (!session) {
      return null;
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      await this.logout(token);
      return null;
    }

    return this.toAuthUser(session.user);
  }

  getSessionTokenFromRequest(req: Request) {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) {
      return undefined;
    }

    const cookies = cookieHeader.split(';');
    for (const cookie of cookies) {
      const [name, ...valueParts] = cookie.trim().split('=');
      if (name === sessionCookieName) {
        return decodeURIComponent(valueParts.join('='));
      }
    }

    return undefined;
  }

  async ensureConfiguredAdminUser() {
    const user = await this.ensureAdminUser(
      this.getAdminUsername(),
      this.getAdminPassword(),
    );
    return this.toAuthUser(user);
  }

  async createUser(username: string, password: string, role = 'user') {
    const normalizedRole = role === 'admin' ? 'admin' : 'user';
    const existingUser = await this.prismaService.user.findUnique({
      where: { username },
    });

    if (existingUser) {
      throw new Error('Username already exists');
    }

    const user = await this.prismaService.user.create({
      data: {
        id: randomUUID(),
        username,
        role: normalizedRole,
        passwordHash: await this.hashPassword(password),
      },
    });

    return this.toAuthUser(user);
  }

  async deleteUser(userId: string) {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new Error('User not found');
    }

    await this.prismaService.user.delete({
      where: { id: userId },
    });

    return this.toAuthUser(user);
  }

  createSessionCookie(token: string, expiresAt: Date) {
    const maxAge = Math.max(
      0,
      Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    );
    return this.serializeCookie(sessionCookieName, token, {
      maxAge,
      expires: expiresAt,
    });
  }

  createClearSessionCookie() {
    return this.serializeCookie(sessionCookieName, '', {
      maxAge: 0,
      expires: new Date(0),
    });
  }

  private async ensureAdminUser(username: string, password: string | undefined) {
    const existingUser = await this.prismaService.user.findUnique({
      where: { username },
    });

    if (existingUser) {
      const adminUser =
        existingUser.role === 'admin'
          ? existingUser
          : await this.prismaService.user.update({
              where: { id: existingUser.id },
              data: { role: 'admin' },
            });
      await this.bootstrapAdminData(adminUser.id);
      return adminUser;
    }

    if (!password) {
      throw new Error(
        'Set ADMIN_PASSWORD, or keep AUTH_CODE as the initial admin password',
      );
    }

    const user = await this.prismaService.user.create({
      data: {
        id: randomUUID(),
        username,
        role: 'admin',
        passwordHash: await this.hashPassword(password),
      },
    });
    await this.bootstrapAdminData(user.id);
    return user;
  }

  private async bootstrapAdminData(userId: string) {
    await this.prismaService.account.updateMany({
      where: { userId: null },
      data: { userId },
    });

    const existingSubscriptions = await this.prismaService.userFeed.count({
      where: { userId },
    });
    if (existingSubscriptions > 0) {
      return;
    }

    const feeds = await this.prismaService.feed.findMany();
    await this.prismaService.$transaction(
      feeds.map((feed) =>
        this.prismaService.userFeed.upsert({
          where: {
            userId_feedId: { userId, feedId: feed.id },
          },
          update: {},
          create: {
            userId,
            feedId: feed.id,
            status: feed.status,
            category: feed.category,
          },
        }),
      ),
    );
  }

  private getAdminUsername() {
    return (
      this.configService.get<ConfigurationType['auth']>('auth')!
        .adminUsername || 'admin'
    );
  }

  private getAdminPassword() {
    const auth = this.configService.get<ConfigurationType['auth']>('auth')!;
    return auth.adminPassword || auth.code;
  }

  private getSessionExpiresAt() {
    const auth = this.configService.get<ConfigurationType['auth']>('auth')!;
    const sessionDays = auth.sessionDays || 30;
    return new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000);
  }

  private async hashPassword(password: string) {
    const salt = randomBytes(16).toString('hex');
    const key = (await scrypt(password, salt, 64)) as Buffer;
    return `${salt}:${key.toString('hex')}`;
  }

  private async verifyPassword(password: string, passwordHash: string) {
    const [salt, storedHash] = passwordHash.split(':');
    if (!salt || !storedHash) {
      return false;
    }

    const storedBuffer = Buffer.from(storedHash, 'hex');
    const key = (await scrypt(password, salt, storedBuffer.length)) as Buffer;
    return (
      storedBuffer.length === key.length && timingSafeEqual(storedBuffer, key)
    );
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private serializeCookie(
    name: string,
    value: string,
    options: { maxAge: number; expires: Date },
  ) {
    const { sessionCookieSecure } =
      this.configService.get<ConfigurationType['auth']>('auth')!;
    const parts = [
      `${name}=${encodeURIComponent(value)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${options.maxAge}`,
      `Expires=${options.expires.toUTCString()}`,
    ];

    if (sessionCookieSecure) {
      parts.push('Secure');
    }

    return parts.join('; ');
  }

  private toAuthUser(user: { id: string; username: string; role: string }): AuthUser {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
    };
  }
}
