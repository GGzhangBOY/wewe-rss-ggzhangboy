import { INestApplication, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { TrpcService } from '@server/trpc/trpc.service';
import * as trpcExpress from '@trpc/server/adapters/express';
import { TRPCError } from '@trpc/server';
import { PrismaService } from '@server/prisma/prisma.service';
import { statusMap } from '@server/constants';
import { RagService } from '@server/rag/rag.service';
import { AuthService } from '@server/auth/auth.service';
import { randomUUID } from 'crypto';

const sourceSchema = z.object({
  title: z.string(),
  source: z.string(),
  category: z.string(),
  url: z.string(),
  publishedAt: z.number(),
  score: z.number(),
  excerpt: z.string(),
});

const knowledgeMessageInputSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(20000),
  sources: z.array(sourceSchema).max(20).optional(),
});

@Injectable()
export class TrpcRouter {
  constructor(
    private readonly trpcService: TrpcService,
    private readonly prismaService: PrismaService,
    private readonly ragService: RagService,
    private readonly authService: AuthService,
  ) {}

  private readonly logger = new Logger(this.constructor.name);

  private async getCurrentUserId(ctx: any) {
    const userId = ctx.user?.id;
    if (userId) {
      return userId as string;
    }

    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Please sign in' });
  }

  private async requireAdmin(ctx: any) {
    if (ctx.user?.role === 'admin') {
      return ctx.user;
    }

    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Admin account required',
    });
  }

  private parseJsonArray<T>(value: string | null | undefined): T[] {
    if (!value) {
      return [];
    }
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private formatKnowledgeConversation(conversation: any) {
    return {
      id: conversation.id,
      title: conversation.title,
      categories: this.parseJsonArray<string>(conversation.categories),
      useKnowledgeBase: conversation.useKnowledgeBase,
      updatedAt: conversation.updatedAt?.getTime?.() || Date.now(),
      messages: (conversation.messages || []).map((message: any) => ({
        role: message.role,
        content: message.content,
        sources: this.parseJsonArray(message.sources),
      })),
      sources: [],
    };
  }

  private mergeUserFeed(userFeed: any) {
    const { feed, status, category, createdAt, updatedAt } = userFeed;
    return {
      ...feed,
      status,
      category,
      subscriptionCreatedAt: createdAt,
      subscriptionUpdatedAt: updatedAt,
    };
  }

  authRouter = this.trpcService.router({
    me: this.trpcService.publicProcedure.query(({ ctx }) => {
      return (ctx as any).user ?? null;
    }),
    login: this.trpcService.publicProcedure
      .input(
        z.object({
          username: z.string().min(1),
          password: z.string().min(1),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        try {
          const { token, expiresAt, user } = await this.authService.login(
            input.username.trim(),
            input.password,
          );
          (ctx as any).res.setHeader(
            'Set-Cookie',
            this.authService.createSessionCookie(token, expiresAt),
          );
          return user;
        } catch (err: any) {
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: err.message || 'Login failed',
          });
        }
      }),
    logout: this.trpcService.protectedProcedure.mutation(async ({ ctx }) => {
      const sessionToken = (ctx as any).sessionToken;
      if (sessionToken) {
        await this.authService.logout(sessionToken);
      }
      (ctx as any).res.setHeader(
        'Set-Cookie',
        this.authService.createClearSessionCookie(),
      );
      return true;
    }),
    users: this.trpcService.protectedProcedure.query(async ({ ctx }) => {
      await this.requireAdmin(ctx);
      return this.prismaService.user.findMany({
        select: {
          id: true,
          username: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'asc' },
      });
    }),
    createUser: this.trpcService.protectedProcedure
      .input(
        z.object({
          username: z.string().min(1).max(255),
          password: z.string().min(8),
          role: z.enum(['user', 'admin']).default('user'),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        await this.requireAdmin(ctx);
        try {
          return await this.authService.createUser(
            input.username.trim(),
            input.password,
            input.role,
          );
        } catch (err: any) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: err.message || 'Failed to create user',
          });
        }
      }),
    deleteUser: this.trpcService.protectedProcedure
      .input(
        z.object({
          id: z.string().min(1),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const adminUser = await this.requireAdmin(ctx);
        if (adminUser.id === input.id) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'You cannot delete the current signed-in user',
          });
        }

        try {
          return await this.authService.deleteUser(input.id);
        } catch (err: any) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: err.message || 'Failed to delete user',
          });
        }
      }),
  });

  accountRouter = this.trpcService.router({
    list: this.trpcService.protectedProcedure
      .input(
        z.object({
          limit: z.number().min(1).max(1000).nullish(),
          cursor: z.string().nullish(),
        }),
      )
      .query(async ({ input, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        const limit = input.limit ?? 1000;
        const { cursor } = input;

        const accountUsers = await this.prismaService.accountUser.findMany({
          take: limit + 1,
          where: { userId },
          include: {
            account: {
              select: {
                id: true,
                name: true,
                status: true,
                createdAt: true,
                updatedAt: true,
                token: false,
              },
            },
          },
          cursor: cursor
            ? {
                userId_accountId: { userId, accountId: cursor },
              }
            : undefined,
          orderBy: {
            createdAt: 'asc',
          },
        });
        let nextCursor: typeof cursor | undefined = undefined;
        if (accountUsers.length > limit) {
          // Remove the last item and use it as next cursor

          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const nextItem = accountUsers.pop()!;
          nextCursor = nextItem.accountId;
        }
        const items = accountUsers.map((item) => item.account);

        const disabledAccounts = this.trpcService.getBlockedAccountIds();
        return {
          blocks: disabledAccounts,
          items,
          nextCursor,
        };
      }),
    byId: this.trpcService.protectedProcedure
      .input(z.string())
      .query(async ({ input: id, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        const accountUser = await this.prismaService.accountUser.findUnique({
          where: { userId_accountId: { userId, accountId: id } },
          include: { account: true },
        });
        if (!accountUser) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `No account with id '${id}'`,
          });
        }
        return accountUser.account;
      }),
    add: this.trpcService.protectedProcedure
      .input(
        z.object({
          id: z.string().min(1).max(32),
          token: z.string().min(1),
          name: z.string().min(1),
          status: z.number().default(statusMap.ENABLE),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        const { id, ...data } = input;
        const account = await this.prismaService.account.upsert({
          where: {
            id,
          },
          update: data,
          create: input,
        });
        await this.prismaService.accountUser.upsert({
          where: {
            userId_accountId: { userId, accountId: id },
          },
          update: {},
          create: {
            userId,
            accountId: id,
          },
        });
        this.trpcService.removeBlockedAccount(id);

        return account;
      }),
    edit: this.trpcService.protectedProcedure
      .input(
        z.object({
          id: z.string(),
          data: z.object({
            token: z.string().min(1).optional(),
            name: z.string().min(1).optional(),
            status: z.number().optional(),
          }),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        const { id, data } = input;
        const accountUser = await this.prismaService.accountUser.findUnique({
          where: { userId_accountId: { userId, accountId: id } },
        });
        if (!accountUser) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `No account with id '${id}'`,
          });
        }
        const account = await this.prismaService.account.update({
          where: { id },
          data,
        });
        this.trpcService.removeBlockedAccount(id);
        return account;
      }),
    delete: this.trpcService.protectedProcedure
      .input(z.string())
      .mutation(async ({ input: id, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        const result = await this.prismaService.accountUser.deleteMany({
          where: { userId, accountId: id },
        });
        if (result.count < 1) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `No account with id '${id}'`,
          });
        }

        const remainingBindings = await this.prismaService.accountUser.count({
          where: { accountId: id },
        });
        if (remainingBindings < 1) {
          await this.prismaService.account.deleteMany({ where: { id } });
          this.trpcService.removeBlockedAccount(id);
        }

        return id;
      }),
  });

  feedRouter = this.trpcService.router({
    list: this.trpcService.protectedProcedure
      .input(
        z.object({
          limit: z.number().min(1).max(1000).nullish(),
          cursor: z.string().nullish(),
        }),
      )
      .query(async ({ input, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        const limit = input.limit ?? 1000;
        const { cursor } = input;

        const userFeeds = await this.prismaService.userFeed.findMany({
          take: limit + 1,
          where: { userId },
          include: { feed: true },
          cursor: cursor
            ? {
                userId_feedId: { userId, feedId: cursor },
              }
            : undefined,
          orderBy: {
            createdAt: 'asc',
          },
        });
        let nextCursor: typeof cursor | undefined = undefined;
        if (userFeeds.length > limit) {
          // Remove the last item and use it as next cursor

          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const nextItem = userFeeds.pop()!;
          nextCursor = nextItem.feedId;
        }

        return {
          items: userFeeds.map((item) => this.mergeUserFeed(item)),
          nextCursor,
        };
      }),
    categories: this.trpcService.protectedProcedure.query(async ({ ctx }) => {
      const userId = await this.getCurrentUserId(ctx);
      const rows = await this.prismaService.userFeed.findMany({
        where: { userId },
        select: { category: true },
        orderBy: { category: 'asc' },
      });
      const categories = rows
        .map((row) => row.category?.trim())
        .filter((category): category is string => Boolean(category));
      return Array.from(new Set(categories));
    }),
    byId: this.trpcService.protectedProcedure
      .input(z.string())
      .query(async ({ input: id, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        const userFeed = await this.prismaService.userFeed.findUnique({
          where: {
            userId_feedId: { userId, feedId: id },
          },
          include: { feed: true },
        });
        if (!userFeed) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `No feed with id '${id}'`,
          });
        }
        return this.mergeUserFeed(userFeed);
      }),
    add: this.trpcService.protectedProcedure
      .input(
        z.object({
          id: z.string(),
          mpName: z.string(),
          mpCover: z.string(),
          mpIntro: z.string(),
          syncTime: z
            .number()
            .optional()
            .default(Math.floor(Date.now() / 1e3)),
          updateTime: z.number(),
          status: z.number().default(statusMap.ENABLE),
          category: z.string().optional().default(''),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        const { id, status, category, ...feedData } = input;
        const feed = await this.prismaService.feed.upsert({
          where: {
            id,
          },
          update: feedData,
          create: {
            id,
            ...feedData,
            status: statusMap.ENABLE,
            category: '',
          },
        });
        const userFeed = await this.prismaService.userFeed.upsert({
          where: {
            userId_feedId: { userId, feedId: id },
          },
          update: {
            status,
            category,
          },
          create: {
            userId,
            feedId: id,
            status,
            category,
          },
          include: { feed: true },
        });

        return this.mergeUserFeed({ ...userFeed, feed });
      }),
    edit: this.trpcService.protectedProcedure
      .input(
        z.object({
          id: z.string(),
          data: z.object({
            mpName: z.string().optional(),
            mpCover: z.string().optional(),
            mpIntro: z.string().optional(),
            syncTime: z.number().optional(),
            updateTime: z.number().optional(),
            status: z.number().optional(),
            category: z.string().optional(),
          }),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        const { id, data } = input;
        const { status, category, ...feedData } = data;
        if (Object.keys(feedData).length) {
          await this.prismaService.feed.update({
            where: { id },
            data: feedData,
          });
        }
        const userFeed = await this.prismaService.userFeed.update({
          where: {
            userId_feedId: { userId, feedId: id },
          },
          data: {
            ...(status === undefined ? {} : { status }),
            ...(category === undefined ? {} : { category }),
          },
          include: { feed: true },
        });
        return this.mergeUserFeed(userFeed);
      }),
    delete: this.trpcService.protectedProcedure
      .input(z.string())
      .mutation(async ({ input: id, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        await this.prismaService.userFeed.deleteMany({
          where: { userId, feedId: id },
        });
        return id;
      }),

    refreshArticles: this.trpcService.protectedProcedure
      .input(
        z.object({
          mpId: z.string().optional(),
        }),
      )
      .mutation(async ({ input: { mpId }, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        if (mpId) {
          const subscription = await this.prismaService.userFeed.findUnique({
            where: { userId_feedId: { userId, feedId: mpId } },
          });
          if (!subscription) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `No feed with id '${mpId}'`,
            });
          }
          await this.trpcService.refreshMpArticlesAndUpdateFeed(mpId, 1, userId);
        } else {
          await this.trpcService.refreshAllMpArticlesAndUpdateFeed(userId);
        }
      }),

    isRefreshAllMpArticlesRunning: this.trpcService.protectedProcedure.query(
      async () => {
        return this.trpcService.isRefreshAllMpArticlesRunning;
      },
    ),
    getHistoryArticles: this.trpcService.protectedProcedure
      .input(
        z.object({
          mpId: z.string().optional(),
        }),
      )
      .mutation(async ({ input: { mpId = '' }, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        if (mpId) {
          const subscription = await this.prismaService.userFeed.findUnique({
            where: { userId_feedId: { userId, feedId: mpId } },
          });
          if (!subscription) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `No feed with id '${mpId}'`,
            });
          }
        }
        this.trpcService.getHistoryMpArticles(mpId, userId);
      }),
    getInProgressHistoryMp: this.trpcService.protectedProcedure.query(
      async () => {
        return this.trpcService.inProgressHistoryMp;
      },
    ),
  });

  articleRouter = this.trpcService.router({
    list: this.trpcService.protectedProcedure
      .input(
        z.object({
          limit: z.number().min(1).max(1000).nullish(),
          cursor: z.string().nullish(),
          mpId: z.string().nullish(),
        }),
      )
      .query(async ({ input, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        const limit = input.limit ?? 1000;
        const { cursor, mpId } = input;
        const subscriptions = await this.prismaService.userFeed.findMany({
          where: mpId ? { userId, feedId: mpId } : { userId },
          select: { feedId: true },
        });
        const feedIds = subscriptions.map((item) => item.feedId);
        if (!feedIds.length) {
          return { items: [], nextCursor: undefined };
        }

        const items = await this.prismaService.article.findMany({
          orderBy: [
            {
              publishTime: 'desc',
            },
          ],
          take: limit + 1,
          where: { mpId: { in: feedIds } },
          cursor: cursor
            ? {
                id: cursor,
              }
            : undefined,
        });
        let nextCursor: typeof cursor | undefined = undefined;
        if (items.length > limit) {
          // Remove the last item and use it as next cursor

          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const nextItem = items.pop()!;
          nextCursor = nextItem.id;
        }

        return {
          items,
          nextCursor,
        };
      }),
    byId: this.trpcService.protectedProcedure
      .input(z.string())
      .query(async ({ input: id, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        const article = await this.prismaService.article.findUnique({
          where: { id },
        });
        if (!article) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `No article with id '${id}'`,
          });
        }
        const subscription = await this.prismaService.userFeed.findUnique({
          where: {
            userId_feedId: { userId, feedId: article.mpId },
          },
        });
        if (!subscription) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `No article with id '${id}'`,
          });
        }
        return article;
      }),

    add: this.trpcService.protectedProcedure
      .input(
        z.object({
          id: z.string(),
          mpId: z.string(),
          title: z.string(),
          picUrl: z.string().optional().default(''),
          publishTime: z.number(),
        }),
      )
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        const article = await this.prismaService.article.upsert({
          where: {
            id,
          },
          update: data,
          create: input,
        });

        return article;
      }),
    delete: this.trpcService.protectedProcedure
      .input(z.string())
      .mutation(async ({ input: id }) => {
        await this.prismaService.article.delete({ where: { id } });
        return id;
      }),
  });

  platformRouter = this.trpcService.router({
    getMpArticles: this.trpcService.protectedProcedure
      .input(
        z.object({
          mpId: z.string(),
        }),
      )
      .mutation(async ({ input: { mpId }, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        try {
          const results = await this.trpcService.getMpArticles(mpId, 1, 3, userId);
          return results;
        } catch (err: any) {
          this.logger.log('getMpArticles err: ', err);
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err.response?.data?.message || err.message,
            cause: err.stack,
          });
        }
      }),
    getMpInfo: this.trpcService.protectedProcedure
      .input(
        z.object({
          wxsLink: z
            .string()
            .refine((v) => v.startsWith('https://mp.weixin.qq.com/s/')),
        }),
      )
      .mutation(async ({ input: { wxsLink: url }, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        try {
          const results = await this.trpcService.getMpInfo(url, userId);
          return results;
        } catch (err: any) {
          this.logger.log('getMpInfo err: ', err);
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err.response?.data?.message || err.message,
            cause: err.stack,
          });
        }
      }),

    createLoginUrl: this.trpcService.protectedProcedure.mutation(async () => {
      return this.trpcService.createLoginUrl();
    }),
    getLoginResult: this.trpcService.protectedProcedure
      .input(
        z.object({
          id: z.string(),
        }),
      )
      .query(async ({ input }) => {
        return this.trpcService.getLoginResult(input.id);
      }),
  });

  ragRouter = this.trpcService.router({
    conversations: this.trpcService.protectedProcedure.query(async ({ ctx }) => {
      const userId = await this.getCurrentUserId(ctx);
      const conversations =
        await this.prismaService.knowledgeConversation.findMany({
          where: { userId },
          include: {
            messages: {
              orderBy: { sequence: 'asc' },
            },
          },
          orderBy: { updatedAt: 'desc' },
          take: 50,
        });
      return conversations.map((conversation) =>
        this.formatKnowledgeConversation(conversation),
      );
    }),
    createConversation: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            title: z.string().min(1).max(255).optional(),
            categories: z.array(z.string().min(1)).max(30).default(['all']),
            useKnowledgeBase: z.boolean().default(true),
          })
          .optional(),
      )
      .mutation(async ({ input, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        const conversation =
          await this.prismaService.knowledgeConversation.create({
            data: {
              id: randomUUID(),
              userId,
              title: input?.title || '新对话',
              categories: JSON.stringify(input?.categories || ['all']),
              useKnowledgeBase: input?.useKnowledgeBase ?? true,
            },
            include: { messages: true },
          });
        return this.formatKnowledgeConversation(conversation);
      }),
    updateConversation: this.trpcService.protectedProcedure
      .input(
        z.object({
          id: z.string().min(1),
          title: z.string().min(1).max(255).optional(),
          categories: z.array(z.string().min(1)).max(30).optional(),
          useKnowledgeBase: z.boolean().optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        const data: any = {};
        if (input.title !== undefined) {
          data.title = input.title;
        }
        if (input.categories !== undefined) {
          data.categories = JSON.stringify(input.categories);
        }
        if (input.useKnowledgeBase !== undefined) {
          data.useKnowledgeBase = input.useKnowledgeBase;
        }

        const result =
          await this.prismaService.knowledgeConversation.updateMany({
            where: { id: input.id, userId },
            data,
          });
        if (result.count < 1) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `No conversation with id '${input.id}'`,
          });
        }
        const conversation =
          await this.prismaService.knowledgeConversation.findFirstOrThrow({
            where: { id: input.id, userId },
            include: { messages: { orderBy: { sequence: 'asc' } } },
          });
        return this.formatKnowledgeConversation(conversation);
      }),
    deleteConversation: this.trpcService.protectedProcedure
      .input(z.object({ id: z.string().min(1) }))
      .mutation(async ({ input, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        await this.prismaService.knowledgeConversation.deleteMany({
          where: { id: input.id, userId },
        });
        return input.id;
      }),
    clearConversation: this.trpcService.protectedProcedure
      .input(z.object({ id: z.string().min(1) }))
      .mutation(async ({ input, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        const conversation =
          await this.prismaService.knowledgeConversation.findFirst({
            where: { id: input.id, userId },
          });
        if (!conversation) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `No conversation with id '${input.id}'`,
          });
        }
        await this.prismaService.knowledgeMessage.deleteMany({
          where: { conversationId: input.id },
        });
        const updated =
          await this.prismaService.knowledgeConversation.update({
            where: { id: input.id },
            data: { title: '新对话' },
            include: { messages: true },
          });
        return this.formatKnowledgeConversation(updated);
      }),
    appendConversationMessages: this.trpcService.protectedProcedure
      .input(
        z.object({
          conversationId: z.string().min(1),
          title: z.string().min(1).max(255),
          categories: z.array(z.string().min(1)).max(30),
          useKnowledgeBase: z.boolean(),
          messages: z.array(knowledgeMessageInputSchema).min(1).max(4),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        const conversation =
          await this.prismaService.knowledgeConversation.findFirst({
            where: { id: input.conversationId, userId },
          });
        if (!conversation) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `No conversation with id '${input.conversationId}'`,
          });
        }
        const latest = await this.prismaService.knowledgeMessage.findFirst({
          where: { conversationId: input.conversationId },
          orderBy: { sequence: 'desc' },
          select: { sequence: true },
        });
        const startSequence = (latest?.sequence ?? -1) + 1;
        await this.prismaService.$transaction([
          ...input.messages.map((message, index) =>
            this.prismaService.knowledgeMessage.create({
              data: {
                id: randomUUID(),
                conversationId: input.conversationId,
                role: message.role,
                content: message.content,
                sources: JSON.stringify(message.sources || []),
                sequence: startSequence + index,
              },
            }),
          ),
          this.prismaService.knowledgeConversation.update({
            where: { id: input.conversationId },
            data: {
              title: input.title,
              categories: JSON.stringify(input.categories),
              useKnowledgeBase: input.useKnowledgeBase,
            },
          }),
        ]);
        const updated =
          await this.prismaService.knowledgeConversation.findFirstOrThrow({
            where: { id: input.conversationId, userId },
            include: { messages: { orderBy: { sequence: 'asc' } } },
          });
        return this.formatKnowledgeConversation(updated);
      }),
    stats: this.trpcService.protectedProcedure.query(async ({ ctx }) => {
      const userId = await this.getCurrentUserId(ctx);
      return this.ragService.stats(userId);
    }),
    dashboard: this.trpcService.protectedProcedure
      .input(
        z
          .object({
            articleLimit: z.number().min(1).max(200).default(30),
          })
          .optional(),
      )
      .query(async ({ input, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        return this.ragService.dashboard({ ...(input || {}), userId });
      }),
    createContentJobs: this.trpcService.protectedProcedure
      .input(
        z.object({
          limit: z.number().min(1).max(500).optional(),
          category: z.string().optional(),
          onlyMissingContent: z.boolean().default(true),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        return this.ragService.createContentJobs({ ...input, userId });
      }),
    claimContentJob: this.trpcService.protectedProcedure
      .input(
        z.object({
          collectorId: z.string().min(1).max(120),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        return this.ragService.claimContentJob({ ...input, userId });
      }),
    submitArticleContent: this.trpcService.protectedProcedure
      .input(
        z.object({
          jobId: z.string().min(1),
          articleId: z.string().min(1),
          title: z.string().min(1),
          author: z.string().optional(),
          content: z.string().min(1),
          contentHtml: z.string().optional(),
          contentLength: z.number().optional(),
          collectorId: z.string().min(1).max(120),
        }),
      )
      .mutation(async ({ input }) => {
        return this.ragService.submitArticleContent(input);
      }),
    failContentJob: this.trpcService.protectedProcedure
      .input(
        z.object({
          jobId: z.string().min(1),
          articleId: z.string().min(1),
          status: z.enum(['failed', 'verify_required', 'empty']),
          reason: z.string().min(1).max(1000),
          collectorId: z.string().min(1).max(120),
        }),
      )
      .mutation(async ({ input }) => {
        return this.ragService.failContentJob(input);
      }),
    contentJobStats: this.trpcService.protectedProcedure.query(async ({ ctx }) => {
      const userId = await this.getCurrentUserId(ctx);
      return this.ragService.contentJobStats(userId);
    }),
    reindex: this.trpcService.protectedProcedure
      .input(
        z.object({
          limit: z.number().min(1).max(400).optional(),
          includeFullText: z.boolean().default(true),
          category: z.string().optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        return this.ragService.reindex({ ...input, userId });
      }),
    ask: this.trpcService.protectedProcedure
      .input(
        z.object({
          question: z.string().min(1).max(1000),
          category: z.string().optional(),
          categories: z.array(z.string().min(1)).max(30).optional(),
          limit: z.number().min(1).max(12).default(8),
          useKnowledgeBase: z.boolean().default(true),
          history: z
            .array(
              z.object({
                role: z.enum(['user', 'assistant']),
                content: z.string().min(1).max(4000),
              }),
            )
            .max(12)
            .optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        return this.ragService.ask({ ...input, userId });
      }),
  });

  appRouter = this.trpcService.router({
    auth: this.authRouter,
    feed: this.feedRouter,
    account: this.accountRouter,
    article: this.articleRouter,
    platform: this.platformRouter,
    rag: this.ragRouter,
  });

  async applyMiddleware(app: INestApplication) {
    app.use(
      `/trpc`,
      trpcExpress.createExpressMiddleware({
        router: this.appRouter,
        createContext: async ({ req, res }) => {
          const sessionToken = this.authService.getSessionTokenFromRequest(req);
          const user =
            await this.authService.getUserFromSessionToken(sessionToken);

          if (user) {
            return {
              errorMsg: null,
              sessionToken,
              user,
              res,
            };
          }

          return {
            errorMsg: 'Please sign in',
            sessionToken: null,
            user: null,
            res,
          };
        },
        middleware: (req, res, next) => {
          next();
        },
      }),
    );
  }
}

export type AppRouter = TrpcRouter[`appRouter`];
