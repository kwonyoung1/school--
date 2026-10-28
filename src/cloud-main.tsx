import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, save, setCsrf, type User } from "./api.ts";
import { OfficeWorkspace, officeNav, type OfficeView } from "./office.tsx";
import { Building2 } from "lucide-react";
import "./style.css";
import "./office.css";
function CloudApp() {
  const [user, setUser] = useState<User | null>(null),
    [loaded, setLoaded] = useState(false),
    [view, setView] = useState<OfficeView>("office-dashboard"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ user: User; csrf: string }>("/me")
      .then((x) => {
        setUser(x.user);
        setCsrf(x.csrf);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
    const expire = () => {
      setUser(null);
      setError("세션이 만료되었습니다. 다시 로그인하세요.");
    };
    window.addEventListener("session-expired", expire);
    return () => window.removeEventListener("session-expired", expire);
  }, []);
  if (!loaded) return <p>업무 환경을 확인하고 있습니다…</p>;
  if (!user)
    return (
      <main className="cloud-login">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            const f = new FormData(e.currentTarget);
            try {
              const x = (await save("/login", {
                username: f.get("username"),
                password: f.get("password"),
              })) as { user: User; csrf: string };
              setUser(x.user);
              setCsrf(x.csrf);
              setError("");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Building2 size={38} color="#1f4e7c" />
          <div>
            <h1>School Office OS</h1>
            <p>학교 행정업무 통합관리</p>
          </div>
          <label className="os-field">
            아이디
            <input
              name="username"
              autoComplete="username"
              required
              defaultValue="admin"
            />
          </label>
          <label className="os-field">
            비밀번호
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          {error && (
            <p className="os-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? "로그인 중…" : "로그인"}
          </button>
          <small>관리자 전용 · 공개 회원가입 없음</small>
        </form>
      </main>
    );
  return (
    <div className="cloud-shell">
      <aside className="cloud-sidebar">
        <b className="cloud-brand">
          School
          <br />
          Office OS<small>학교 행정실 업무공간</small>
        </b>
        <nav>
          {officeNav.map(([key, label, Icon]) => (
            <button
              key={key}
              className={view === key ? "active" : ""}
              onClick={() => setView(key)}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
        <p className="os-hint">
          시설 · 지출 · 오늘 한 일<br />
          개인 행정업무 시스템
        </p>
      </aside>
      <div className="cloud-main">
        <header className="cloud-header">
          <span>행정지원 / {officeNav.find((x) => x[0] === view)?.[1]}</span>
          <div>
            관리자{" "}
            <button
              onClick={async () => {
                try {
                  await save("/logout", {});
                  setUser(null);
                  setCsrf("");
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              로그아웃
            </button>
          </div>
        </header>
        <div className="cloud-heading">
          <span className="eyebrow">SCHOOL OFFICE OS</span>
          <h1>{officeNav.find((x) => x[0] === view)?.[1]}</h1>
          <p>학교 PC, 집 PC, 휴대폰에서 같은 업무를 이어가세요.</p>
        </div>
        {error && <p role="alert">{error}</p>}
        <OfficeWorkspace view={view} onView={setView} user={user} />
        <footer>School Office OS · 한국시간 기준 · 시설·지출 통합관리</footer>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<CloudApp />);
