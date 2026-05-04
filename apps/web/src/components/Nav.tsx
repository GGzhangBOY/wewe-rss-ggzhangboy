import {
  Badge,
  Image,
  Link,
  Navbar,
  NavbarBrand,
  NavbarContent,
  NavbarItem,
  Tooltip,
  Button,
} from '@nextui-org/react';
import { ThemeSwitcher } from './ThemeSwitcher';
import { GitHubIcon } from './GitHubIcon';
import { useLocation, useNavigate } from 'react-router-dom';
import { appVersion, serverOriginUrl } from '@web/utils/env';
import { useEffect, useState } from 'react';
import { trpc } from '@web/utils/trpc';

const navbarItemLink = [
  {
    href: '/feeds',
    name: '公众号源',
  },
  {
    href: '/knowledge',
    name: '知识问答',
    exact: true,
  },
  {
    href: '/knowledge/indexing',
    name: '索引配置',
  },
  {
    href: '/accounts',
    name: '账号管理',
  },
  {
    href: '/users',
    name: '用户管理',
    adminOnly: true,
  },
  // {
  //   href: '/settings',
  //   name: '设置',
  // },
];

const Nav = () => {
  const { pathname } = useLocation();
  const isLoginPage = pathname === '/login';
  const navigate = useNavigate();
  const [releaseVersion, setReleaseVersion] = useState(appVersion);
  const queryUtils = trpc.useContext();
  const { data: currentUser } = trpc.auth.me.useQuery(undefined, {
    retry: false,
  });
  const { mutateAsync: logout } = trpc.auth.logout.useMutation({
    async onSuccess() {
      await queryUtils.auth.me.invalidate();
      navigate('/login');
    },
  });

  useEffect(() => {
    fetch('https://api.github.com/repos/cooderl/wewe-rss/releases/latest')
      .then((res) => res.json())
      .then((data) => {
        setReleaseVersion(data.name.replace('v', ''));
      });
  }, []);

  const isFoundNewVersion = releaseVersion > appVersion;
  console.log('isFoundNewVersion: ', isFoundNewVersion);
  const visibleNavbarItems = navbarItemLink.filter(
    (item) => !item.adminOnly || currentUser?.role === 'admin',
  );

  return (
    <div>
      <Navbar isBordered>
        <Tooltip
          content={
            <div className="p-1">
              {isFoundNewVersion && (
                <Link
                  href={`https://github.com/cooderl/wewe-rss/releases/latest`}
                  target="_blank"
                  className="mb-1 block text-medium"
                >
                  发现新版本：v{releaseVersion}
                </Link>
              )}
              当前版本: v{appVersion}
            </div>
          }
          placement="left"
        >
          <NavbarBrand className="cursor-default">
            <Badge
              content={isFoundNewVersion ? '' : null}
              color="danger"
              size="sm"
            >
              <Image
                width={28}
                alt="WeWe RSS"
                className="mr-2"
                src={
                  serverOriginUrl
                    ? `${serverOriginUrl}/favicon.ico`
                    : 'https://r2-assets.111965.xyz/wewe-rss.png'
                }
              ></Image>
            </Badge>
            <p className="font-bold text-inherit">WeWe RSS</p>
          </NavbarBrand>
        </Tooltip>
        {!isLoginPage ? (
          <NavbarContent className="hidden sm:flex gap-4" justify="center">
            {visibleNavbarItems.map((item) => {
              const isActive = item.exact
                ? pathname === item.href
                : pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <NavbarItem
                  isActive={isActive}
                  key={item.href}
                >
                  <Link color="foreground" href={item.href}>
                    {item.name}
                  </Link>
                </NavbarItem>
              );
            })}
          </NavbarContent>
        ) : null}
        <NavbarContent justify="end">
          {currentUser && !isLoginPage ? (
            <Button
              size="sm"
              variant="light"
              onPress={() => {
                void logout();
              }}
            >
              Sign out
            </Button>
          ) : null}
          <ThemeSwitcher></ThemeSwitcher>
          <Link
            href="https://github.com/cooderl/wewe-rss"
            target="_blank"
            color="foreground"
          >
            <GitHubIcon />
          </Link>
        </NavbarContent>
      </Navbar>
    </div>
  );
};

export default Nav;
