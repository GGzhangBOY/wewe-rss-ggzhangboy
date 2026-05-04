import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Input,
  Select,
  SelectItem,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from '@nextui-org/react';
import dayjs from 'dayjs';
import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { toast } from 'sonner';
import { trpc } from '@web/utils/trpc';

type UserRole = 'user' | 'admin';

const UsersPage = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('user');

  const { data: currentUser, isLoading: isLoadingCurrentUser } =
    trpc.auth.me.useQuery();
  const isAdmin = currentUser?.role === 'admin';
  const { data, refetch, isFetching } = trpc.auth.users.useQuery(undefined, {
    enabled: isAdmin,
  });
  const { mutateAsync: createUser, isLoading } =
    trpc.auth.createUser.useMutation();
  const { mutateAsync: deleteUser, isLoading: isDeleting } =
    trpc.auth.deleteUser.useMutation();

  const handleCreateUser = async () => {
    await createUser({
      username: username.trim(),
      password,
      role,
    });
    toast.success('User created');
    setUsername('');
    setPassword('');
    setRole('user');
    await refetch();
  };

  const handleDeleteUser = async (userId: string, targetUsername: string) => {
    if (!window.confirm(`Delete user "${targetUsername}"?`)) {
      return;
    }

    await deleteUser({ id: userId });
    toast.success('User deleted');
    await refetch();
  };

  if (!isLoadingCurrentUser && !currentUser) {
    return <Navigate to="/login" replace />;
  }

  if (!isLoadingCurrentUser && !isAdmin) {
    return (
      <div className="h-full overflow-y-auto p-4">
        <Card radius="sm">
          <CardBody>No permission</CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
        <Card radius="sm">
          <CardHeader className="font-medium">Create User</CardHeader>
          <CardBody className="gap-4">
            <Input
              label="Username"
              value={username}
              onValueChange={setUsername}
              autoComplete="username"
            />
            <Input
              label="Password"
              value={password}
              onValueChange={setPassword}
              type="password"
              autoComplete="new-password"
            />
            <Select
              label="Account type"
              selectedKeys={[role]}
              onSelectionChange={(keys) => {
                const selectedRole = Array.from(keys as Set<string>)[0];
                if (selectedRole === 'user' || selectedRole === 'admin') {
                  setRole(selectedRole);
                }
              }}
            >
              <SelectItem key="user" value="user">
                Normal user
              </SelectItem>
              <SelectItem key="admin" value="admin">
                Admin user
              </SelectItem>
            </Select>
            <Button
              color="primary"
              isDisabled={!username.trim() || password.length < 8}
              isLoading={isLoading}
              onPress={handleCreateUser}
            >
              Create
            </Button>
          </CardBody>
        </Card>

        <Card radius="sm">
          <CardHeader className="font-medium">Users</CardHeader>
          <CardBody>
            <Table removeWrapper aria-label="Users">
              <TableHeader>
                <TableColumn>Username</TableColumn>
                <TableColumn>Type</TableColumn>
                <TableColumn>Created</TableColumn>
                <TableColumn>Updated</TableColumn>
                <TableColumn>Actions</TableColumn>
              </TableHeader>
              <TableBody
                emptyContent="No users"
                isLoading={isFetching}
                items={data || []}
              >
                {(item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.username}</TableCell>
                    <TableCell>
                      {item.role === 'admin' ? 'Admin user' : 'Normal user'}
                    </TableCell>
                    <TableCell>
                      {dayjs(item.createdAt).format('YYYY-MM-DD HH:mm')}
                    </TableCell>
                    <TableCell>
                      {item.updatedAt
                        ? dayjs(item.updatedAt).format('YYYY-MM-DD HH:mm')
                        : '-'}
                    </TableCell>
                    <TableCell>
                      <Button
                        color="danger"
                        isDisabled={item.id === currentUser?.id}
                        isLoading={isDeleting}
                        size="sm"
                        variant="light"
                        onPress={() => handleDeleteUser(item.id, item.username)}
                      >
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardBody>
        </Card>
      </div>
    </div>
  );
};

export default UsersPage;
