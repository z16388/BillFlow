import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./lib";
import { Badge, Button, Modal } from "./components/ui";
type User = {
  id: string;
  username: string;
  role: string;
  active: boolean;
  created: string;
};
export default function Accounts({
  user,
  notify,
}: {
  user: User;
  notify: (text: string, error?: boolean) => void;
}) {
  const qc = useQueryClient();
  const isAdmin = user.role === "admin";
  const users = useQuery<User[]>({
    queryKey: ["users"],
    queryFn: () => api("/users"),
    enabled: isAdmin,
  });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    username: "",
    password: "",
    role: "user",
  });
  const [reset, setReset] = useState<User | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [initialConfirm, setInitialConfirm] = useState("");
  const [passwords, setPasswords] = useState({
    current_password: "",
    new_password: "",
  });
  const [busy, setBusy] = useState(false);
  async function update(target: User, patch: object) {
    setBusy(true);
    try {
      await api("/users/" + target.id, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      await qc.invalidateQueries({ queryKey: ["users"] });
      setReset(null);
      setResetPassword("");
      notify("账号已更新");
      if (target.id === user.id) location.reload();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="accounts-page">
      <section className="card account-section">
        <div className="section-head">
          <div>
            <h2>我的账号</h2>
            <p>
              {user.username} · {isAdmin ? "管理员" : "普通账号"}
            </p>
          </div>
          <Button
            variant="outline"
            onClick={async () => {
              await api("/auth/logout", { method: "POST" });
              qc.clear();
              location.reload();
            }}
          >
            退出登录
          </Button>
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (passwords.new_password !== confirmPassword) {
              notify("两次输入的新密码不一致", true);
              return;
            }
            setBusy(true);
            try {
              await api("/auth/password", {
                method: "POST",
                body: JSON.stringify({
                  ...passwords,
                  confirm_password: confirmPassword,
                }),
              });
              qc.clear();
              location.reload();
            } catch (err) {
              notify((err as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-grid">
            <label className="field">
              当前密码
              <input
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
                value={passwords.current_password}
                onChange={(e) =>
                  setPasswords({
                    ...passwords,
                    current_password: e.target.value,
                  })
                }
              />
            </label>
            <label className="field">
              新密码
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={128}
                value={passwords.new_password}
                onChange={(e) =>
                  setPasswords({ ...passwords, new_password: e.target.value })
                }
              />
            </label>
          </div>
          <label className="field password-confirm-field">
            再次输入新密码
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={128}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </label>
          <Button variant="outline" disabled={busy}>
            修改密码并重新登录
          </Button>
        </form>
      </section>
      {isAdmin && (
        <section className="card account-section">
          <div className="section-head">
            <div>
              <h2>账号管理</h2>
            </div>
            <Button onClick={() => setAdding(true)}>创建账号</Button>
          </div>
          {users.isError && (
            <p className="error-text">账号读取失败，请刷新重试。</p>
          )}
          {users.data?.map((u) => (
            <div className="account-row-item" key={u.id}>
              <div>
                <strong>
                  {u.username}
                  {u.id === user.id ? "（当前账号）" : ""}
                </strong>
                <small>
                  {u.role === "admin" ? "管理员" : "普通账号"} ·{" "}
                  {u.active ? "已启用" : "已停用"}
                </small>
              </div>
              <Badge tone={u.active ? "green" : "neutral"}>
                {u.active ? "启用" : "停用"}
              </Badge>
              <div className="account-actions">
                {u.id !== "admin" && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        update(u, {
                          role: u.role === "admin" ? "user" : "admin",
                        })
                      }
                    >
                      {u.role === "admin" ? "设为普通账号" : "设为管理员"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => update(u, { active: !u.active })}
                    >
                      {u.active ? "停用" : "启用"}
                    </Button>
                  </>
                )}
                {u.id === "admin" && (
                  <span className="root-account-note">
                    默认管理员 · 永久启用
                  </span>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setReset(u);
                    setResetPassword("");
                    setResetConfirm("");
                  }}
                >
                  重置密码
                </Button>
              </div>
            </div>
          ))}
        </section>
      )}
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="创建账号"
        description="新账号从独立的空账本开始，不能访问其他账号的数据。"
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (form.password !== initialConfirm) {
              notify("两次输入的初始密码不一致", true);
              return;
            }
            setBusy(true);
            try {
              await api("/users", {
                method: "POST",
                body: JSON.stringify(form),
              });
              await qc.invalidateQueries({ queryKey: ["users"] });
              setAdding(false);
              setForm({ username: "", password: "", role: "user" });
              setInitialConfirm("");
              notify("账号已创建");
            } catch (err) {
              notify((err as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="field">
            账号名
            <input
              required
              minLength={3}
              maxLength={40}
              pattern="[A-Za-z0-9_.\-]+"
              autoComplete="off"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
            <small>3–40 位字母、数字、下划线、点或短横线</small>
          </label>
          <label className="field">
            初始密码
            <input
              required
              minLength={8}
              maxLength={128}
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </label>
          <label className="field">
            再次输入初始密码
            <input
              type="password"
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              value={initialConfirm}
              onChange={(e) => setInitialConfirm(e.target.value)}
            />
          </label>
          <label className="field">
            角色
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            >
              <option value="user">普通账号</option>
              <option value="admin">管理员</option>
            </select>
          </label>
          <Button disabled={busy}>创建账号</Button>
        </form>
      </Modal>
      <Modal
        open={!!reset}
        onClose={() => setReset(null)}
        title={`重置 ${reset?.username || ""} 的密码`}
        description="重置后，该账号的现有登录会话失效。"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (resetPassword !== resetConfirm) {
              notify("两次输入的新密码不一致", true);
              return;
            }
            if (reset)
              update(reset, {
                password: resetPassword,
                confirm_password: resetConfirm,
              });
          }}
        >
          <label className="field">
            新密码
            <input
              type="password"
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
            />
          </label>
          <label className="field">
            再次输入新密码
            <input
              type="password"
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              value={resetConfirm}
              onChange={(e) => setResetConfirm(e.target.value)}
            />
          </label>
          <Button disabled={busy}>确认重置密码</Button>
        </form>
      </Modal>
    </div>
  );
}
