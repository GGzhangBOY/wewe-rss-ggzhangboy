import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Divider,
  Input,
  Link,
  Progress,
  Select,
  SelectItem,
  Spinner,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@nextui-org/react';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@web/utils/trpc';

const metricClass = 'text-2xl font-semibold';

const KnowledgeIndexing = () => {
  const [category, setCategory] = useState('all');
  const [indexLimit, setIndexLimit] = useState(30);
  const [includeFullText, setIncludeFullText] = useState(true);

  const { data: feedData } = trpc.feed.list.useQuery({});
  const { data: dashboard, refetch: refetchDashboard } =
    trpc.rag.dashboard.useQuery({ articleLimit: 50 });
  const { mutateAsync: reindex, isLoading: isIndexing } =
    trpc.rag.reindex.useMutation();

  const categories = useMemo(() => {
    const values = new Set<string>();
    (feedData?.items || []).forEach((item) => {
      values.add(item.category || '未分类');
    });
    return ['all', ...Array.from(values)];
  }, [feedData?.items]);

  const handleReindex = async () => {
    const result = await reindex({
      limit: indexLimit,
      includeFullText,
      category: category === 'all' ? undefined : category,
    });
    toast.success('索引完成', {
      description: `文章 ${result.indexedArticles} 篇，片段 ${result.indexedChunks} 个`,
    });
    refetchDashboard();
  };

  const summary = dashboard?.summary;

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">索引配置</h2>
          <p className="text-sm text-default-500">
            查看文章入库、正文覆盖、RAG 索引覆盖和分类健康度。
          </p>
        </div>
        <Chip color="primary" variant="flat">
          {summary?.chunkCount || 0} chunks
        </Chip>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[340px_1fr]">
        <Card radius="sm">
          <CardHeader className="font-medium">重建索引</CardHeader>
          <Divider />
          <CardBody className="gap-4">
            <Select
              label="分类"
              selectedKeys={[category]}
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
            <Input
              type="number"
              label="本次索引文章数"
              min={1}
              max={200}
              value={`${indexLimit}`}
              onValueChange={(value) =>
                setIndexLimit(Math.min(200, Math.max(1, Number(value || 30))))
              }
            />
            <Switch isSelected={includeFullText} onValueChange={setIncludeFullText}>
              抓取正文
            </Switch>
            <Button
              color="primary"
              isDisabled={isIndexing}
              onPress={handleReindex}
            >
              {isIndexing && <Spinner color="white" size="sm" />}
              重建索引
            </Button>
          </CardBody>
        </Card>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricCard label="公众号" value={summary?.feedCount || 0} />
            <MetricCard label="文章入库" value={summary?.articleCount || 0} />
            <MetricCard
              label="已索引文章"
              value={summary?.indexedArticleCount || 0}
              suffix={`${summary?.indexCoverage || 0}%`}
            />
            <MetricCard
              label="有正文文章"
              value={summary?.fullTextArticleCount || 0}
              suffix={`${summary?.fullTextCoverage || 0}%`}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card radius="sm">
              <CardHeader className="font-medium">索引覆盖</CardHeader>
              <CardBody className="gap-3">
                <Progress
                  aria-label="索引覆盖率"
                  value={summary?.indexCoverage || 0}
                />
                <div className="flex justify-between text-sm text-default-500">
                  <span>已索引 {summary?.indexedArticleCount || 0}</span>
                  <span>未索引 {summary?.unindexedArticleCount || 0}</span>
                </div>
              </CardBody>
            </Card>
            <Card radius="sm">
              <CardHeader className="font-medium">正文覆盖</CardHeader>
              <CardBody className="gap-3">
                <Progress
                  aria-label="正文覆盖率"
                  color="success"
                  value={summary?.fullTextCoverage || 0}
                />
                <div className="flex justify-between text-sm text-default-500">
                  <span>有正文 {summary?.fullTextArticleCount || 0}</span>
                  <span>仅标题 {summary?.titleOnlyArticleCount || 0}</span>
                </div>
              </CardBody>
            </Card>
            <Card radius="sm">
              <CardHeader className="font-medium">诊断提示</CardHeader>
              <CardBody className="text-sm text-default-600">
                正文覆盖率偏低时，知识问答只能基于标题和公众号简介回答。优先查看“仅标题”的文章是否被微信验证页拦截。
              </CardBody>
            </Card>
          </div>

          <Card radius="sm">
            <CardHeader className="font-medium">分类看板</CardHeader>
            <Divider />
            <CardBody>
              <Table removeWrapper aria-label="分类索引看板">
                <TableHeader>
                  <TableColumn>分类</TableColumn>
                  <TableColumn>公众号</TableColumn>
                  <TableColumn>文章</TableColumn>
                  <TableColumn>索引覆盖</TableColumn>
                  <TableColumn>正文覆盖</TableColumn>
                  <TableColumn>仅标题</TableColumn>
                  <TableColumn>最近索引</TableColumn>
                </TableHeader>
                <TableBody emptyContent="暂无分类数据">
                  {(dashboard?.categories || []).map((item) => (
                    <TableRow key={item.category}>
                      <TableCell>{item.category}</TableCell>
                      <TableCell>{item.feedCount}</TableCell>
                      <TableCell>{item.articleCount}</TableCell>
                      <TableCell>{item.indexCoverage}%</TableCell>
                      <TableCell>{item.fullTextCoverage}%</TableCell>
                      <TableCell>{item.titleOnlyArticleCount}</TableCell>
                      <TableCell>
                        {item.latestIndexedAt
                          ? dayjs(item.latestIndexedAt).format('MM-DD HH:mm')
                          : '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardBody>
          </Card>

          <Card radius="sm">
            <CardHeader className="font-medium">最近文章落库明细</CardHeader>
            <Divider />
            <CardBody>
              <Table removeWrapper aria-label="文章落库明细">
                <TableHeader>
                  <TableColumn>标题</TableColumn>
                  <TableColumn>分类</TableColumn>
                  <TableColumn>发布时间</TableColumn>
                  <TableColumn>状态</TableColumn>
                  <TableColumn>字数</TableColumn>
                  <TableColumn>Chunks</TableColumn>
                  <TableColumn>索引时间</TableColumn>
                </TableHeader>
                <TableBody emptyContent="暂无文章数据">
                  {(dashboard?.recentArticles || []).map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <Link href={item.sourceUrl} target="_blank">
                          {item.title}
                        </Link>
                        <div className="text-xs text-default-500">
                          {item.source}
                        </div>
                      </TableCell>
                      <TableCell>{item.category}</TableCell>
                      <TableCell>
                        {dayjs(item.publishedAt * 1000).format('YYYY-MM-DD')}
                      </TableCell>
                      <TableCell>
                        <Chip
                          color={
                            item.status === '有正文'
                              ? 'success'
                              : item.status === '仅标题'
                                ? 'warning'
                                : 'default'
                          }
                          size="sm"
                          variant="flat"
                        >
                          {item.status}
                        </Chip>
                      </TableCell>
                      <TableCell>{item.contentLength}</TableCell>
                      <TableCell>{item.chunkCount}</TableCell>
                      <TableCell>
                        {item.indexedAt
                          ? dayjs(item.indexedAt).format('MM-DD HH:mm')
                          : '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
};

const MetricCard = ({
  label,
  value,
  suffix,
}: {
  label: string;
  value: number;
  suffix?: string;
}) => (
  <Card radius="sm">
    <CardBody>
      <div className="text-sm text-default-500">{label}</div>
      <div className="mt-2 flex items-end gap-2">
        <span className={metricClass}>{value}</span>
        {suffix && <span className="pb-1 text-sm text-default-500">{suffix}</span>}
      </div>
    </CardBody>
  </Card>
);

export default KnowledgeIndexing;
