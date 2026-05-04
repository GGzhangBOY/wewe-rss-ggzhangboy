import { Button, Input } from '@nextui-org/react';
import { trpc } from '@web/utils/trpc';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const LoginPage = () => {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');

  const navigate = useNavigate();
  const queryUtils = trpc.useContext();
  const { mutateAsync: login, isLoading } = trpc.auth.login.useMutation();

  const handleLogin = async () => {
    await login({ username: username.trim(), password });
    await queryUtils.auth.me.invalidate();
    navigate('/');
  };

  return (
    <div className="m-auto mt-[10vh] flex w-full max-w-sm flex-col gap-4 rounded-large bg-content1 px-8 pb-10 pt-6 shadow-small">
      <Input
        value={username}
        onValueChange={setUsername}
        label="Username"
        placeholder="admin"
        autoComplete="username"
      />
      <Input
        value={password}
        onValueChange={setPassword}
        label="Password"
        placeholder="Admin password"
        type="password"
        autoComplete="current-password"
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            void handleLogin();
          }
        }}
      />
      <Button color="primary" isLoading={isLoading} onPress={handleLogin}>
        Sign in
      </Button>
    </div>
  );
};

export default LoginPage;
