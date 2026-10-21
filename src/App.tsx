import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { configured, supabase } from "./supabase";
import Promissorias from "./Promissorias";
import Clientes from "./Clientes";
import RenegociacaoCobranca from "./RenegociacaoCobranca";
import Dashboard from "./Dashboard";
import logo from "./logo.png";

function Login() {
  const [usuario, setUsuario] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function go(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    let loginEmail = usuario.trim();
    if (!loginEmail.includes("@")) {
      const u = loginEmail.toLowerCase();
      if (u === "suporte") loginEmail = "suporte@leooticas.com.br";
      else if (u === "leooticas") loginEmail = "leooticas@leooticas.com.br";
      else loginEmail = `${u}@leooticas.com.br`;
    }
    const { error } = await supabase.auth.signInWithPassword({ email: loginEmail, password: pw });
    if (error) setErr("Usuário/e-mail ou senha inválidos.");
    setBusy(false);
  }
  return (
    <div className="login">
      <form className="card" onSubmit={go}>
        <div style={{ textAlign: "center", marginBottom: 18 }}>
          <img src={logo} alt="LeoÓticas" className="login-logo" />
          <div className="brand">LeoÓticas<i>.</i>fin</div>
          <div className="sub">Promissórias Loja — acesso restrito</div>
        </div>
        <label>Usuário ou E-mail<input type="text" required autoCapitalize="none" autoCorrect="off" value={usuario} onChange={e => setUsuario(e.target.value)} /></label>
        <label>Senha<input type="password" required value={pw} onChange={e => setPw(e.target.value)} /></label>
        <div className="err">{err}</div>
        <button className="btn" disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
      </form>
    </div>
  );
}

const TABS = [
  ["dashboard", "Dashboard"],
  ["promissorias", "Promissórias"],
  ["clientes", "Clientes"],
  ["renegociacao", "Renegociação & Cobrança"],
] as const;
type Tab = (typeof TABS)[number][0];

function Shell({ session }: { session: Session }) {
  const [role, setRole] = useState<"user" | "admin">("user");
  const [tab, setTab] = useState<Tab>("dashboard");
  const isAdmin = role === "admin";
  useEffect(() => {
    supabase.from("profiles").select("role").eq("id", session.user.id).maybeSingle()
      .then(({ data }) => setRole(data?.role === "admin" ? "admin" : "user"));
  }, [session.user.id]);
  return (
    <>
      <header className="noprint">
        <img src={logo} alt="LeoÓticas" className="header-logo" />
        <div><div className="brand">LeoÓticas<i>.</i>fin</div><div className="sub">Promissórias Loja</div></div>
        <div className="sp" />
        <span className="role">{session.user.email} · {isAdmin ? "administrador" : "leitura"}</span>
        <button className="btn ghost" onClick={() => supabase.auth.signOut()}>Sair</button>
      </header>
      <nav className="tabs noprint">
        {TABS.map(([k, l]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
      </nav>
      <main>
        {tab === "dashboard" && <Dashboard onNavegarAba={(t) => setTab(t as Tab)} />}
        {tab === "promissorias" && <Promissorias isAdmin={isAdmin} />}
        {tab === "clientes" && <Clientes isAdmin={isAdmin} />}
        {tab === "renegociacao" && <RenegociacaoCobranca />}
      </main>
    </>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    if (!configured) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  if (!configured) return <div className="warn">Defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY (veja o README).</div>;
  if (session === undefined) return <div className="login">Carregando…</div>;
  return session ? <Shell session={session} /> : <Login />;
}
