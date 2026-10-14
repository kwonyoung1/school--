export type User = {
  id: string;
  username: string;
  name: string;
  role: "admin" | "staff" | "viewer";
};
let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData) && options.body)
    headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET")
    headers.set("X-CSRF-Token", csrf);
  const res = await fetch("/api" + path, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "서버 연결에 실패했습니다" }));
    if (res.status === 401 && path !== "/login")
      window.dispatchEvent(new Event("session-expired"));
    throw new Error(data.error || "요청 실패");
  }
  return res.json() as Promise<T>;
}
export function save(path: string, data: unknown, method = "POST") {
  return api(path, { method, body: JSON.stringify(data) });
}
export async function download(path: string, name: string) {
  const res = await fetch("/api" + path, { credentials: "same-origin" });
  if (!res.ok) throw new Error("다운로드 권한 또는 연결을 확인하세요");
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
