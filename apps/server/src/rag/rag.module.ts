import { Module } from '@nestjs/common';
import { PrismaModule } from '@server/prisma/prisma.module';
import { RagService } from './rag.service';

@Module({
  imports: [PrismaModule],
  providers: [RagService],
  exports: [RagService],
})
export class RagModule {}
