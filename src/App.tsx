import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { configured, supabase } from "./supabase";
import Promissorias from "./Promissorias";
import Clientes from "./Clientes";
import Relatorio from "./Relatorio";

function Login() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function go(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
    if (error) setErr("E-mail ou senha inválidos.");
    setBusy(false);
  }
  return (
    <div className="login">
      <form className="card" onSubmit={go}>
        <div className="brand">gestão<i>.</i>fin</div>
        <div className="sub">Promissórias Loja — acesso restrito</div>
        <label>E-mail<input type="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label>Senha<input type="password" required value={pw} onChange={e => setPw(e.target.value)} /></label>
        <div className="err">{err}</div>
        <button className="btn" disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
      </form>
    </div>
  );
}

const TABS = [["promissorias", "Promissórias"], ["clientes", "Clientes"], ["relatorio", "Relatório"]] as const;
type Tab = (typeof TABS)[number][0];

function Shell({ session }: { session: Session }) {
  const [role, setRole] = useState<"user" | "admin">("user");
  const [tab, setTab] = useState<Tab>("promissorias");
  const isAdmin = role === "admin";
  useEffect(() => {
    supabase.from("profiles").select("role").eq("id", session.user.id).maybeSingle()
      .then(({ data }) => setRole(data?.role === "admin" ? "admin" : "user"));
  }, [session.user.id]);
  return (
    <>
      <header className="noprint">
        <div className="gf">GF</div>
        <div><div className="brand">gestão<i>.</i>fin</div><div className="sub">Promissórias Loja</div></div>
        <div className="sp" />
        <span className="role">{session.user.email} · {isAdmin ? "administrador" : "leitura"}</span>
        <button className="btn ghost" onClick={() => supabase.auth.signOut()}>Sair</button>
      </header>
      <nav className="tabs noprint">
        {TABS.map(([k, l]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
      </nav>
      <main>
        {tab === "promissorias" && <Promissorias isAdmin={isAdmin} />}
        {tab === "clientes" && <Clientes isAdmin={isAdmin} />}
        {tab === "relatorio" && <Relatorio />}
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
