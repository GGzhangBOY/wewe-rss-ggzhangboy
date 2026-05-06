import { INestApplication, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { TrpcService } from '@server/trpc/trpc.service';
import * as trpcExpress from '@trpc/server/adapters/express';
import { TRPCError } from '@trpc/server';
import { PrismaService } from '@server/prisma/prisma.service';
import { statusMap } from '@server/constants';
import { RagService } from '@server/rag/rag.service';
import { AuthService } from '@server/auth/auth.service';

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

        const items = await this.prismaService.account.findMany({
          take: limit + 1,
          where: { userId },
          select: {
            id: true,
            name: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            token: false,
          },
          cursor: cursor
            ? {
                id: cursor,
              }
            : undefined,
          orderBy: {
            createdAt: 'asc',
          },
        });
        let nextCursor: typeof cursor | undefined = undefined;
        if (items.length > limit) {
          // Remove the last item and use it as next cursor

          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const nextItem = items.pop()!;
          nextCursor = nextItem.id;
        }

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
        const account = await this.prismaService.account.findFirst({
          where: { id, userId },
        });
        if (!account) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `No account with id '${id}'`,
          });
        }
        return account;
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
        const existingAccount = await this.prismaService.account.findUnique({
          where: { id },
          select: { userId: true },
        });
        if (existingAccount?.userId && existingAccount.userId !== userId) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Account '${id}' belongs to another user`,
          });
        }
        const account = await this.prismaService.account.upsert({
          where: {
            id,
          },
          update: { ...data, userId },
          create: { ...input, userId },
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
        const result = await this.prismaService.account.updateMany({
          where: { id, userId },
          data,
        });
        if (result.count < 1) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `No account with id '${id}'`,
          });
        }
        const account = await this.prismaService.account.findFirstOrThrow({
          where: { id, userId },
        });
        this.trpcService.removeBlockedAccount(id);
        return account;
      }),
    delete: this.trpcService.protectedProcedure
      .input(z.string())
      .mutation(async ({ input: id, ctx }) => {
        const userId = await this.getCurrentUserId(ctx);
        await this.prismaService.account.deleteMany({ where: { id, userId } });
        this.trpcService.removeBlockedAccount(id);

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
