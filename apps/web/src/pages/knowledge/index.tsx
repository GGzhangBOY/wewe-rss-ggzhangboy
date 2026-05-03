import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Divider,
  Link,
  Select,
  SelectItem,
  Spinner,
  Textarea,
} from '@nextui-org/react';
import dayjs from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@web/utils/trpc';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type Source = {
  title: string;
  source: string;
  category: string;
  url: string;
  publishedAt: number;
  score: number;
  excerpt: string;
};

type Conversation = {
  id: string;
  title: string;
  category: string;
  updatedAt: number;
  messages: ChatMessage[];
  sources: Source[];
};

const STORAGE_KEY = 'wewe-rss-knowledge-conversations';

const createConversation = (): Conversation => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  title: '新对话',
  category: 'all',
  updatedAt: Date.now(),
  messages: [],
  sources: [],
});

const Knowledge = () => {
  const [question, setQuestion] = useState('');
  const [category, setCategory] = useState('all');
  const [conversations, setConversations] = useState<Conversation[]>([
    createConversation(),
  ]);
  const [activeId, setActiveId] = useState(conversations[0].id);

  const { data: feedData } = trpc.feed.list.useQuery({});
  const { data: stats } = trpc.rag.stats.useQuery();
  const { mutateAsync: ask, isLoading: isAsking } = trpc.rag.ask.useMutation();

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return;
    }
    try {
      const parsed = JSON.parse(stored) as Conversation[];
      if (parsed.length) {
        setConversations(parsed);
        setActiveId(parsed[0].id);
        setCategory(parsed[0].category || 'all');
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations.slice(0, 30)));
  }, [conversations]);

  const activeConversation =
    conversations.find((item) => item.id === activeId) || conversations[0];

  const categories = useMemo(() => {
    const values = new Set<string>();
    (feedData?.items || []).forEach((item) => {
      values.add(item.category || '未分类');
    });
    return ['all', ...Array.from(values)];
  }, [feedData?.items]);

  const updateConversation = (
    id: string,
    updater: (conversation: Conversation) => Conversation,
  ) => {
    setConversations((items) =>
      items
        .map((item) => (item.id === id ? updater(item) : item))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    );
  };

  const handleNewConversation = () => {
    const next = createConversation();
    setConversations((items) => [next, ...items]);
    setActiveId(next.id);
    setCategory('all');
    setQuestion('');
  };

  const handleSelectConversation = (id: string) => {
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) {
      return;
    }
    setActiveId(id);
    setCategory(conversation.category || 'all');
    setQuestion('');
  };

  const handleClearConversation = () => {
    updateConversation(activeId, (conversation) => ({
      ...conversation,
      title: '新对话',
      updatedAt: Date.now(),
      messages: [],
      sources: [],
    }));
  };

  const handleAsk = async () => {
    const text = question.trim();
    if (!text) {
      toast.error('请输入问题');
      return;
    }

    const history = activeConversation.messages.slice(-12);
    const result = await ask({
      question: text,
      category: category === 'all' ? undefined : category,
      limit: 8,
      history,
    });

    updateConversation(activeId, (conversation) => ({
      ...conversation,
      title: conversation.messages.length ? conversation.title : text.slice(0, 28),
      category,
      updatedAt: Date.now(),
      messages: [
        ...conversation.messages,
        { role: 'user', content: text },
        { role: 'assistant', content: result.answer },
      ],
      sources: result.sources,
    }));
    setQuestion('');
  };

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">知识问答</h2>
          <p className="text-sm text-default-500">
            基于已索引的公众号内容进行多轮问答，回答会保留当前浏览器的历史对话。
          </p>
        </div>
        <Chip color="primary" variant="flat">
          {stats?.totalChunks || 0} chunks
        </Chip>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
        <Card radius="sm">
          <CardHeader className="flex items-center justify-between">
            <span className="font-medium">历史对话</span>
            <Button size="sm" variant="flat" onPress={handleNewConversation}>
              新建
            </Button>
          </CardHeader>
          <Divider />
          <CardBody className="gap-2">
            {conversations.map((conversation) => (
              <button
                className={`rounded-small px-3 py-2 text-left text-sm transition ${
                  conversation.id === activeId
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-default-100 hover:bg-default-200'
                }`}
                key={conversation.id}
                onClick={() => handleSelectConversation(conversation.id)}
                type="button"
              >
                <div className="line-clamp-1 font-medium">{conversation.title}</div>
                <div
                  className={`mt-1 text-xs ${
                    conversation.id === activeId
                      ? 'text-primary-foreground/80'
                      : 'text-default-500'
                  }`}
                >
                  {dayjs(conversation.updatedAt).format('MM-DD HH:mm')} /{' '}
                  {conversation.messages.length} 条
                </div>
              </button>
            ))}
          </CardBody>
        </Card>

        <Card radius="sm">
          <CardHeader className="flex flex-wrap items-center justify-between gap-3">
            <div className="font-medium">对话</div>
            <div className="flex items-center gap-2">
              <Select
                aria-label="分类"
                className="w-40"
                selectedKeys={[category]}
                size="sm"
                onSelectionChange={(keys) =>
                  setCategory(Array.from(keys)[0] as string)
                }
              >
                {categories.map((item) => (
                  <SelectItem key={item}>
                    {item === 'all' ? '全部分类' : item}
                  </SelectItem>
                ))}
              </Select>
              <Button size="sm" variant="flat" onPress={handleClearConversation}>
                清空
              </Button>
            </div>
          </CardHeader>
          <Divider />
          <CardBody className="gap-4">
            <div className="min-h-[360px] space-y-4">
              {!activeConversation.messages.length && (
                <div className="rounded-small bg-default-100 p-4 text-sm text-default-500">
                  输入问题开始对话。后续追问会带上最近几轮上下文。
                </div>
              )}
              {activeConversation.messages.map((message, index) => (
                <div
                  className={`flex ${
                    message.role === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                  key={`${message.role}-${index}`}
                >
                  <div
                    className={`max-w-[86%] whitespace-pre-wrap rounded-small p-3 text-sm leading-6 ${
                      message.role === 'user'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-default-100'
                    }`}
                  >
                    {message.content}
                  </div>
                </div>
              ))}
            </div>

            {!!activeConversation.sources.length && (
              <>
                <Divider />
                <div>
                  <div className="mb-2 text-sm font-medium">最近引用来源</div>
                  <div className="space-y-3">
                    {activeConversation.sources.map((source, index) => (
                      <div
                        className="rounded-small border border-default-200 p-3 text-sm"
                        key={`${source.url}-${index}`}
                      >
                        <div className="mb-1 flex items-center gap-2">
                          <Chip size="sm" variant="flat">
                            {(source.score * 100).toFixed(1)}
                          </Chip>
                          <Link href={source.url} target="_blank">
                            {source.title}
                          </Link>
                        </div>
                        <div className="mb-2 text-xs text-default-500">
                          {source.source} / {source.category} /{' '}
                          {dayjs(source.publishedAt * 1000).format('YYYY-MM-DD')}
                        </div>
                        <div className="text-default-600">{source.excerpt}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            <Divider />
            <Textarea
              minRows={3}
              label="问题"
              placeholder="继续追问，或输入一个新的知识库问题"
              value={question}
              onValueChange={setQuestion}
            />
            <div className="flex justify-end">
              <Button color="primary" isDisabled={isAsking} onPress={handleAsk}>
                {isAsking && <Spinner color="white" size="sm" />}
                提问
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
};

export default Knowledge;
