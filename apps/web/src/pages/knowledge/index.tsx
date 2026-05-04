import {
  Accordion,
  AccordionItem,
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
  Switch,
  Textarea,
} from '@nextui-org/react';
import dayjs from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@web/utils/trpc';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
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
  useKnowledgeBase: boolean;
  updatedAt: number;
  messages: ChatMessage[];
  sources: Source[];
};

type CategoryOption = {
  key: string;
  label: string;
  count?: number;
};

const STORAGE_KEY = 'wewe-rss-knowledge-conversations';

const createConversation = (): Conversation => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  title: '新对话',
  category: 'all',
  useKnowledgeBase: true,
  updatedAt: Date.now(),
  messages: [],
  sources: [],
});

const Knowledge = () => {
  const [question, setQuestion] = useState('');
  const [category, setCategory] = useState('all');
  const [useKnowledgeBase, setUseKnowledgeBase] = useState(true);
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
      const normalized = parsed.map((conversation) => {
        const messages = conversation.messages || [];
        return {
          ...conversation,
          category: conversation.category || 'all',
          useKnowledgeBase: conversation.useKnowledgeBase ?? true,
          messages: messages.map((message, index) => {
            const isLastAssistant =
              index === messages.length - 1 && message.role === 'assistant';
            if (
              isLastAssistant &&
              !message.sources?.length &&
              conversation.sources?.length
            ) {
              return { ...message, sources: conversation.sources };
            }
            return message;
          }),
          sources: [],
        };
      });
      if (normalized.length) {
        setConversations(normalized);
        setActiveId(normalized[0].id);
        setCategory(normalized[0].category || 'all');
        setUseKnowledgeBase(normalized[0].useKnowledgeBase ?? true);
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

  const categories = useMemo<CategoryOption[]>(() => {
    const indexedCategories = (stats?.categories || [])
      .filter((item) => item.category)
      .map((item) => ({
        key: item.category,
        label: item.category,
        count: item.count,
      }));

    if (indexedCategories.length) {
      return [
        {
          key: 'all',
          label: '全部分类',
          count: stats?.totalChunks || 0,
        },
        ...indexedCategories,
      ];
    }

    const values = new Set<string>();
    (feedData?.items || []).forEach((item) => {
      values.add(item.category || '未分类');
    });
    return [
      { key: 'all', label: '全部分类' },
      ...Array.from(values).map((item) => ({ key: item, label: item })),
    ];
  }, [feedData?.items, stats?.categories, stats?.totalChunks]);

  const activeCategory = categories.some((item) => item.key === category)
    ? category
    : 'all';

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
    setUseKnowledgeBase(true);
    setQuestion('');
  };

  const handleSelectConversation = (id: string) => {
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) {
      return;
    }
    setActiveId(id);
    setCategory(conversation.category || 'all');
    setUseKnowledgeBase(conversation.useKnowledgeBase ?? true);
    setQuestion('');
  };

  const handleCategoryChange = (selectedCategory: string) => {
    setCategory(selectedCategory);
    updateConversation(activeId, (conversation) => ({
      ...conversation,
      category: selectedCategory,
      updatedAt: Date.now(),
    }));
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

  const handleDeleteConversation = (id: string) => {
    const nextConversations = conversations.filter((item) => item.id !== id);
    if (!nextConversations.length) {
      const next = createConversation();
      setConversations([next]);
      setActiveId(next.id);
      setCategory('all');
      setUseKnowledgeBase(true);
      setQuestion('');
      toast.success('对话已删除');
      return;
    }

    setConversations(nextConversations);
    if (id === activeId) {
      const next = nextConversations[0];
      setActiveId(next.id);
      setCategory(next.category || 'all');
      setUseKnowledgeBase(next.useKnowledgeBase ?? true);
      setQuestion('');
    }
    toast.success('对话已删除');
  };

  const handleKnowledgeBaseChange = (selected: boolean) => {
    setUseKnowledgeBase(selected);
    setConversations((items) =>
      items.map((item) =>
        item.id === activeId
          ? {
              ...item,
              useKnowledgeBase: selected,
              sources: selected ? item.sources : [],
            }
          : item,
      ),
    );
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
      category:
        useKnowledgeBase && activeCategory !== 'all' ? activeCategory : undefined,
      limit: 8,
      useKnowledgeBase,
      history,
    });

    updateConversation(activeId, (conversation) => ({
      ...conversation,
      title: conversation.messages.length ? conversation.title : text.slice(0, 28),
      category: activeCategory,
      useKnowledgeBase,
      updatedAt: Date.now(),
      messages: [
        ...conversation.messages,
        { role: 'user', content: text },
        {
          role: 'assistant',
          content: result.answer,
          sources: useKnowledgeBase ? result.sources : [],
        },
      ],
      sources: [],
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
              <div
                className={`flex items-start gap-2 rounded-small p-2 text-sm transition ${
                  conversation.id === activeId
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-default-100 hover:bg-default-200'
                }`}
                key={conversation.id}
              >
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => handleSelectConversation(conversation.id)}
                  type="button"
                >
                  <div className="line-clamp-1 font-medium">
                    {conversation.title}
                  </div>
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
                <Button
                  color="danger"
                  size="sm"
                  variant={conversation.id === activeId ? 'solid' : 'light'}
                  onPress={() => handleDeleteConversation(conversation.id)}
                >
                  删除
                </Button>
              </div>
            ))}
          </CardBody>
        </Card>

        <Card radius="sm">
          <CardHeader className="flex flex-wrap items-center justify-between gap-3">
            <div className="font-medium">对话</div>
            <div className="flex items-center gap-2">
              <Select
                aria-label="分类"
                className="w-52"
                isDisabled={!useKnowledgeBase}
                selectedKeys={[activeCategory]}
                size="sm"
                onSelectionChange={(keys) =>
                  handleCategoryChange(Array.from(keys)[0] as string)
                }
              >
                {categories.map((item) => (
                  <SelectItem key={item.key} textValue={item.label}>
                    {item.count === undefined
                      ? item.label
                      : `${item.label} (${item.count})`}
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
                    className={`max-w-[86%] rounded-small p-3 text-sm leading-6 ${
                      message.role === 'user'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-default-100'
                    }`}
                  >
                    <div className="whitespace-pre-wrap">{message.content}</div>
                    {message.role === 'assistant' && !!message.sources?.length && (
                      <Accordion
                        className="mt-3 px-0"
                        itemClasses={{
                          base: 'px-0',
                          title: 'text-sm font-medium',
                          trigger: 'py-2',
                          content: 'pt-0',
                        }}
                        variant="light"
                      >
                        <AccordionItem
                          key="sources"
                          aria-label="引用来源"
                          subtitle={`${message.sources.length} 条来源`}
                          title="引用来源"
                        >
                          <div className="space-y-2">
                            {message.sources.map((source, sourceIndex) => (
                              <div
                                className="rounded-small border border-default-200 bg-background/40 p-3 text-sm"
                                key={`${source.url}-${sourceIndex}`}
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
                                  {dayjs(source.publishedAt * 1000).format(
                                    'YYYY-MM-DD',
                                  )}
                                </div>
                                <div className="text-default-600">
                                  {source.excerpt}
                                </div>
                              </div>
                            ))}
                          </div>
                        </AccordionItem>
                      </Accordion>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <Divider />
            <Textarea
              minRows={3}
              label="问题"
              placeholder={
                useKnowledgeBase
                  ? '继续追问，或输入一个新的知识库问题'
                  : '直接向模型提问，不查询知识库'
              }
              value={question}
              onValueChange={setQuestion}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Switch
                isSelected={useKnowledgeBase}
                size="sm"
                onValueChange={handleKnowledgeBaseChange}
              >
                查询知识库
              </Switch>
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
