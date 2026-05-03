import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@server/prisma/prisma.service';
import { ConfigurationType } from '@server/configuration';
import axios from 'axios';
import got from 'got';
import { load } from 'cheerio';
import { createHash } from 'crypto';

type RagChunk = {
  id: string;
  article_id: string;
  chunk_index: number;
  title: string;
  mp_id: string;
  mp_name: string;
  category: string;
  source_url: string;
  published_at: number;
  content: string;
  vector: string;
  score?: number;
};

type ChatHistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

const VECTOR_DIMS = 384;
const MAX_CONTEXT_CHARS = 9000;

@Injectable()
export class RagService {
  private readonly logger = new Logger(this.constructor.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async ensureSchema() {
    await this.prismaService.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS rag_chunks (
        id TEXT PRIMARY KEY,
        article_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        mp_id TEXT NOT NULL,
        mp_name TEXT NOT NULL,
        category TEXT NOT NULL,
        source_url TEXT NOT NULL,
        published_at INTEGER NOT NULL,
        content TEXT NOT NULL,
        vector TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    await this.prismaService.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_rag_chunks_article_id ON rag_chunks(article_id)`,
    );
    await this.prismaService.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_rag_chunks_category ON rag_chunks(category)`,
    );
    await this.prismaService.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_rag_chunks_published_at ON rag_chunks(published_at)`,
    );
  }

  async reindex({
    limit = 30,
    includeFullText = true,
    category,
  }: {
    limit?: number;
    includeFullText?: boolean;
    category?: string;
  }) {
    await this.ensureSchema();
    if (category) {
      await this.prismaService.$executeRawUnsafe(
        `DELETE FROM rag_chunks WHERE category = ?`,
        category,
      );
    } else {
      await this.prismaService.$executeRawUnsafe(`DELETE FROM rag_chunks`);
    }

    const feeds = await this.prismaService.feed.findMany();
    const feedMap = new Map(feeds.map((feed) => [feed.id, feed]));
    const filteredFeedIds = category
      ? feeds
          .filter((feed) => (feed.category || '未分类') === category)
          .map((feed) => feed.id)
      : undefined;

    const articles = await this.prismaService.article.findMany({
      take: limit,
      where: filteredFeedIds ? { mpId: { in: filteredFeedIds } } : undefined,
      orderBy: { publishTime: 'desc' },
    });

    let indexedArticles = 0;
    let indexedChunks = 0;

    for (const article of articles) {
      const feed = feedMap.get(article.mpId);
      const mpName = feed?.mpName || article.mpId;
      const feedCategory = feed?.category || '未分类';
      const sourceUrl = `https://mp.weixin.qq.com/s/${article.id}`;
      const fetchedBody = includeFullText
        ? await this.fetchArticleText(sourceUrl).catch((err) => {
            this.logger.warn(
              `fetch article text failed: ${article.id}, ${err.message}`,
            );
            return '';
          })
        : '';
      const body = this.isInvalidArticleText(fetchedBody) ? '' : fetchedBody;

      const baseContent = [
        `标题：${article.title}`,
        `公众号：${mpName}`,
        `分类：${feedCategory}`,
        feed?.mpIntro ? `公众号简介：${feed.mpIntro}` : '',
        body ? `正文：\n${body}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      const chunks = this.chunkText(baseContent);
      const now = new Date().toISOString();
      await this.prismaService.$executeRawUnsafe(
        `DELETE FROM rag_chunks WHERE article_id = ?`,
        article.id,
      );

      for (let index = 0; index < chunks.length; index += 1) {
        const content = chunks[index];
        const id = `${article.id}:${index}`;
        const vector = JSON.stringify(this.embedText(content));
        const contentHash = this.hash(content);

        await this.prismaService.$executeRawUnsafe(
          `
            INSERT INTO rag_chunks (
              id, article_id, chunk_index, title, mp_id, mp_name, category,
              source_url, published_at, content, vector, content_hash,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          id,
          article.id,
          index,
          article.title,
          article.mpId,
          mpName,
          feedCategory,
          sourceUrl,
          article.publishTime,
          content,
          vector,
          contentHash,
          now,
          now,
        );
        indexedChunks += 1;
      }
      indexedArticles += 1;
    }

    const total = await this.countChunks();
    return { indexedArticles, indexedChunks, totalChunks: total };
  }

  async ask({
    question,
    category,
    limit = 8,
    history = [],
  }: {
    question: string;
    category?: string;
    limit?: number;
    history?: ChatHistoryMessage[];
  }) {
    await this.ensureSchema();
    const searchText = this.buildSearchText(question, history);
    const chunks = await this.search(searchText, { category, limit });

    if (!chunks.length) {
      return {
        answer:
          '当前知识库还没有可用于回答的公众号内容。请先执行知识库索引。',
        sources: [],
      };
    }

    const answer = await this.callMiniMax(question, chunks, history);
    return {
      answer,
      sources: chunks.map((chunk) => ({
        title: chunk.title,
        source: chunk.mp_name,
        category: chunk.category,
        url: chunk.source_url,
        publishedAt: chunk.published_at,
        score: chunk.score || 0,
        excerpt: chunk.content.slice(0, 280),
      })),
    };
  }

  async stats() {
    await this.ensureSchema();
    const totalChunks = await this.countChunks();
    const rows = await this.prismaService.$queryRawUnsafe<
      Array<{ category: string; count: bigint | number }>
    >(
      `SELECT category, COUNT(*) as count FROM rag_chunks GROUP BY category ORDER BY count DESC`,
    );
    return {
      totalChunks,
      categories: rows.map((row) => ({
        category: row.category,
        count: Number(row.count),
      })),
    };
  }

  async dashboard({ articleLimit = 30 }: { articleLimit?: number } = {}) {
    await this.ensureSchema();

    const feeds = await this.prismaService.feed.findMany();
    const articles = await this.prismaService.article.findMany({
      orderBy: { publishTime: 'desc' },
    });
    const chunks = await this.prismaService.$queryRawUnsafe<
      Array<{
        article_id: string;
        title: string;
        mp_id: string;
        mp_name: string;
        category: string;
        published_at: number;
        content: string;
        created_at: string;
        updated_at: string;
        chunk_count: bigint | number;
        content_length: bigint | number;
      }>
    >(`
      SELECT
        article_id,
        title,
        mp_id,
        mp_name,
        category,
        published_at,
        MIN(content) as content,
        MIN(created_at) as created_at,
        MAX(updated_at) as updated_at,
        COUNT(*) as chunk_count,
        SUM(LENGTH(content)) as content_length
      FROM rag_chunks
      GROUP BY article_id
    `);

    const feedMap = new Map(feeds.map((feed) => [feed.id, feed]));
    const chunkMap = new Map(chunks.map((chunk) => [chunk.article_id, chunk]));
    const categories = new Map<
      string,
      {
        category: string;
        feedCount: number;
        articleCount: number;
        indexedArticleCount: number;
        chunkCount: number;
        fullTextArticleCount: number;
        titleOnlyArticleCount: number;
        failedArticleCount: number;
        latestPublishedAt: number;
        latestIndexedAt: string;
      }
    >();

    const ensureCategory = (category: string) => {
      if (!categories.has(category)) {
        categories.set(category, {
          category,
          feedCount: 0,
          articleCount: 0,
          indexedArticleCount: 0,
          chunkCount: 0,
          fullTextArticleCount: 0,
          titleOnlyArticleCount: 0,
          failedArticleCount: 0,
          latestPublishedAt: 0,
          latestIndexedAt: '',
        });
      }
      return categories.get(category)!;
    };

    for (const feed of feeds) {
      ensureCategory(feed.category || '未分类').feedCount += 1;
    }

    for (const article of articles) {
      const feed = feedMap.get(article.mpId);
      const category = feed?.category || '未分类';
      const bucket = ensureCategory(category);
      const chunk = chunkMap.get(article.id);
      bucket.articleCount += 1;
      bucket.latestPublishedAt = Math.max(
        bucket.latestPublishedAt,
        article.publishTime,
      );

      if (chunk) {
        const contentLength = Number(chunk.content_length || 0);
        const chunkCount = Number(chunk.chunk_count || 0);
        bucket.indexedArticleCount += 1;
        bucket.chunkCount += chunkCount;
        bucket.latestIndexedAt =
          !bucket.latestIndexedAt || chunk.updated_at > bucket.latestIndexedAt
            ? chunk.updated_at
            : bucket.latestIndexedAt;

        if (this.hasFullTextContent(chunk.content)) {
          bucket.fullTextArticleCount += 1;
        } else if (contentLength > 0) {
          bucket.titleOnlyArticleCount += 1;
        } else {
          bucket.failedArticleCount += 1;
        }
      }
    }

    const totalArticles = articles.length;
    const indexedArticles = chunks.length;
    const fullTextArticles = chunks.filter((chunk) =>
      this.hasFullTextContent(chunk.content),
    ).length;
    const titleOnlyArticles = chunks.filter(
      (chunk) =>
        !this.hasFullTextContent(chunk.content) &&
        Number(chunk.content_length || 0) > 0,
    ).length;

    const recentArticles = articles.slice(0, articleLimit).map((article) => {
      const feed = feedMap.get(article.mpId);
      const chunk = chunkMap.get(article.id);
      const contentLength = Number(chunk?.content_length || 0);
      const hasFullText = chunk ? this.hasFullTextContent(chunk.content) : false;

      return {
        id: article.id,
        title: article.title,
        source: feed?.mpName || article.mpId,
        category: feed?.category || '未分类',
        publishedAt: article.publishTime,
        indexed: Boolean(chunk),
        hasFullText,
        contentLength,
        chunkCount: Number(chunk?.chunk_count || 0),
        indexedAt: chunk?.updated_at || '',
        status: !chunk ? '未索引' : hasFullText ? '有正文' : '仅标题',
        sourceUrl: `https://mp.weixin.qq.com/s/${article.id}`,
      };
    });

    const categoryRows = Array.from(categories.values())
      .map((row) => ({
        ...row,
        indexCoverage: this.percent(row.indexedArticleCount, row.articleCount),
        fullTextCoverage: this.percent(
          row.fullTextArticleCount,
          row.indexedArticleCount,
        ),
      }))
      .sort((a, b) => b.articleCount - a.articleCount);

    return {
      summary: {
        feedCount: feeds.length,
        articleCount: totalArticles,
        indexedArticleCount: indexedArticles,
        chunkCount: chunks.reduce(
          (sum, chunk) => sum + Number(chunk.chunk_count || 0),
          0,
        ),
        fullTextArticleCount: fullTextArticles,
        titleOnlyArticleCount: titleOnlyArticles,
        unindexedArticleCount: Math.max(totalArticles - indexedArticles, 0),
        indexCoverage: this.percent(indexedArticles, totalArticles),
        fullTextCoverage: this.percent(fullTextArticles, indexedArticles),
      },
      categories: categoryRows,
      recentArticles,
    };
  }

  private async search(
    question: string,
    { category, limit }: { category?: string; limit: number },
  ) {
    const queryVector = this.embedText(question);
    const rows = category
      ? await this.prismaService.$queryRawUnsafe<RagChunk[]>(
          `SELECT * FROM rag_chunks WHERE category = ? ORDER BY published_at DESC LIMIT 600`,
          category,
        )
      : await this.prismaService.$queryRawUnsafe<RagChunk[]>(
          `SELECT * FROM rag_chunks ORDER BY published_at DESC LIMIT 800`,
        );

    return rows
      .map((row) => ({
        ...row,
        score:
          this.cosine(queryVector, JSON.parse(row.vector)) +
          this.keywordScore(question, row),
      }))
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, limit);
  }

  private keywordScore(question: string, chunk: RagChunk) {
    const queryTokens = new Set(this.extractQueryTerms(question));
    if (!queryTokens.size) {
      return 0;
    }

    const title = chunk.title.toLowerCase();
    const content = chunk.content.toLowerCase();
    let score = 0;

    for (const token of queryTokens) {
      if (title.includes(token)) {
        score += token.length > 1 ? 0.24 : 0.08;
      }
      if (content.includes(token)) {
        score += token.length > 1 ? 0.08 : 0.02;
      }
    }

    const normalizedQuestion = this.normalizeText(question).toLowerCase();
    if (normalizedQuestion && title.includes(normalizedQuestion)) {
      score += 1;
    }

    return Number(score.toFixed(6));
  }

  private extractQueryTerms(question: string) {
    const normalized = this.normalizeText(question).toLowerCase();
    const terms = new Set(this.tokenize(normalized));
    const compactChineseText = (normalized.match(/[\u4e00-\u9fa5]+/g) || []).join('');

    for (let size = 2; size <= 4; size += 1) {
      for (let index = 0; index <= compactChineseText.length - size; index += 1) {
        const term = compactChineseText.slice(index, index + size);
        if (!this.isWeakQueryTerm(term)) {
          terms.add(term);
        }
      }
    }

    return Array.from(terms).filter((term) => !this.isWeakQueryTerm(term));
  }

  private isWeakQueryTerm(term: string) {
    return (
      term.length < 2 ||
      /^(最近|哪个|一个|这个|那个|什么|怎么|如何|是否|可以|自己|有哪|哪一个)$/.test(term)
    );
  }

  private buildSearchText(question: string, history: ChatHistoryMessage[]) {
    const recentUserQuestions = history
      .filter((message) => message.role === 'user')
      .slice(-3)
      .map((message) => message.content);
    return [...recentUserQuestions, question].join('\n');
  }

  private async callMiniMax(
    question: string,
    chunks: RagChunk[],
    history: ChatHistoryMessage[],
  ) {
    const ragConfig = this.configService.get<ConfigurationType['rag']>('rag')!;
    if (!ragConfig.minimaxApiKey) {
      return '未配置 MINIMAX_API_KEY，已完成检索但无法调用大模型生成回答。';
    }

    const context = chunks
      .map((chunk, index) => {
        const published = new Date(chunk.published_at * 1000)
          .toISOString()
          .slice(0, 10);
        return [
          `资料 ${index + 1}`,
          `标题：${chunk.title}`,
          `来源：${chunk.mp_name}`,
          `分类：${chunk.category}`,
          `发布时间：${published}`,
          `链接：${chunk.source_url}`,
          `内容：${chunk.content}`,
        ].join('\n');
      })
      .join('\n\n---\n\n')
      .slice(0, MAX_CONTEXT_CHARS);

    const historyMessages = history.slice(-8).map((message) => ({
      role: message.role,
      content: message.content,
    }));

    const messages = [
      {
        role: 'system',
        content:
          '你是公众号知识库问答助手。优先根据用户提供的资料回答，并在关键结论后标注资料编号。资料可能只有标题、来源和链接；如果标题已经足以定位相关条目，请先给出最相关条目，再说明资料未提供更多正文细节。不要把“环境异常”“去验证”“无法访问”等反爬提示当作正文依据。',
      },
      ...historyMessages,
      {
        role: 'user',
        content: `问题：${question}\n\n资料：\n${context}`,
      },
    ];

    const apiUrl = ragConfig.minimaxApiBaseUrl.replace(/\/$/, '');
    const endpoint = apiUrl.endsWith('/v1')
      ? `${apiUrl}/chat/completions`
      : apiUrl;

    const { data } = await axios.post(
      endpoint,
      {
        model: ragConfig.minimaxModel,
        messages,
        temperature: 0.2,
        max_tokens: 1200,
      },
      {
        timeout: 60_000,
        headers: {
          Authorization: `Bearer ${ragConfig.minimaxApiKey}`,
          'Content-Type': 'application/json',
        },
      },
    );

    const content =
      data?.choices?.[0]?.message?.content ||
      data?.choices?.[0]?.messages?.[0]?.text ||
      data?.choices?.[0]?.text ||
      data?.reply ||
      data?.output_text ||
      data?.data?.choices?.[0]?.message?.content;

    if (!content) {
      this.logger.warn(`unexpected MiniMax response: ${JSON.stringify(data)}`);
      return '大模型返回格式无法解析，请检查 MINIMAX_API_BASE_URL 和 MINIMAX_MODEL 配置。';
    }
    return this.stripThinking(content);
  }

  private async fetchArticleText(url: string) {
    const html = await got(url, {
      timeout: 8_000,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    }).text();
    const $ = load(html);
    $('script, style, noscript, svg, canvas').remove();
    const content =
      $('#js_content').text() ||
      $('.rich_media_content').text() ||
      $('article').text() ||
      $('body').text();
    return this.normalizeText(content);
  }

  private chunkText(text: string) {
    const normalized = this.normalizeText(text);
    const chunks: string[] = [];
    const maxLength = 1200;
    for (let start = 0; start < normalized.length; start += maxLength) {
      const chunk = normalized.slice(start, start + maxLength).trim();
      if (chunk.length > 30) {
        chunks.push(chunk);
      }
      if (chunks.length >= 8) {
        break;
      }
    }
    return chunks.length ? chunks : [normalized.slice(0, maxLength)];
  }

  private normalizeText(text: string) {
    return text
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private isInvalidArticleText(text: string) {
    const normalized = this.normalizeText(text);
    if (!normalized) {
      return true;
    }
    const invalidMarkers = ['环境异常', '完成验证后即可继续访问', '去验证'];
    const markerCount = invalidMarkers.filter((marker) =>
      normalized.includes(marker),
    ).length;
    return markerCount >= 2 || normalized.length < 80;
  }

  private hasFullTextContent(content: string) {
    const normalized = this.normalizeText(content);
    if (!normalized || this.isInvalidArticleText(normalized)) {
      return false;
    }
    return /正文：\s*\S/.test(normalized) || normalized.length >= 500;
  }

  private percent(value: number, total: number) {
    if (!total) {
      return 0;
    }
    return Number(((value / total) * 100).toFixed(1));
  }

  private stripThinking(content: string) {
    return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  private embedText(text: string) {
    const vector = new Array(VECTOR_DIMS).fill(0);
    const tokens = this.tokenize(text);
    for (const token of tokens) {
      const hash = this.hashNumber(token);
      const index = Math.abs(hash) % VECTOR_DIMS;
      const sign = hash % 2 === 0 ? 1 : -1;
      vector[index] += sign;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm ? vector.map((value) => Number((value / norm).toFixed(6))) : vector;
  }

  private tokenize(text: string) {
    const lower = text.toLowerCase();
    const words = lower.match(/[a-z0-9_]{2,}|[\u4e00-\u9fa5]/g) || [];
    const tokens = [...words];
    for (let i = 0; i < words.length - 1; i += 1) {
      if (/^[\u4e00-\u9fa5]$/.test(words[i]) && /^[\u4e00-\u9fa5]$/.test(words[i + 1])) {
        tokens.push(words[i] + words[i + 1]);
      }
    }
    return tokens;
  }

  private cosine(a: number[], b: number[]) {
    let result = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      result += a[i] * b[i];
    }
    return Number(result.toFixed(6));
  }

  private hash(content: string) {
    return createHash('sha256').update(content).digest('hex');
  }

  private hashNumber(content: string) {
    const hash = createHash('md5').update(content).digest();
    return hash.readInt32BE(0);
  }

  private async countChunks() {
    const rows = await this.prismaService.$queryRawUnsafe<
      Array<{ count: bigint | number }>
    >(`SELECT COUNT(*) as count FROM rag_chunks`);
    return Number(rows[0]?.count || 0);
  }
}
