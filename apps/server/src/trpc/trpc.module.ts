import { Module } from '@nestjs/common';
import { TrpcService } from '@server/trpc/trpc.service';
import { TrpcRouter } from '@server/trpc/trpc.router';
import { PrismaModule } from '@server/prisma/prisma.module';
import { RagModule } from '@server/rag/rag.module';
import { AuthModule } from '@server/auth/auth.module';

@Module({
  imports: [PrismaModule, RagModule, AuthModule],
  controllers: [],
  providers: [TrpcService, TrpcRouter],
  exports: [TrpcService, TrpcRouter],
})
export class TrpcModule {}
