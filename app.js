import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const CATEGORIES = ["仕事・事業", "執筆・創作", "学び", "健康・習慣", "人間関係", "お金", "暮らし", "遊び・挑戦", "趣味"];
const STATUSES = ["未着手", "進行中", "達成", "保留", "断念"];
const STATUS_CLASS = { "進行中": "doing", "達成": "done", "保留": "hold", "断念": "drop" };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtDate = (d) => (d ? d.replace(/-/g, "/") : "");

const cfg = window.APP_CONFIG || {};
if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
  $("setup").hidden = false;
  $("cards").innerHTML = "";
  throw new Error("config.js が未設定");
}
const sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

let session = null;
let myRows = [];        // 編集中の自分の目標
let deletedIds = [];    // 保存時に消す行
let dirty = false;

// ---------- 閲覧 ----------
async function loadPublic() {
  const [{ data: profiles, error: e1 }, { data: goals, error: e2 }] = await Promise.all([
    sb.from("profiles").select("user_id, display_name, declared_on"),
    sb.from("goals").select("id, user_id, position, goal, due, category, status, memo").order("position"),
  ]);
  if (e1 || e2) {
    $("cards").innerHTML = `<p class="empty">データを読み込めませんでした。</p>`;
    return;
  }
  const byUser = new Map();
  for (const p of profiles) byUser.set(p.user_id, { ...p, goals: [] });
  for (const g of goals) {
    if (!byUser.has(g.user_id)) byUser.set(g.user_id, { user_id: g.user_id, display_name: "", goals: [] });
    byUser.get(g.user_id).goals.push(g);
  }
  const members = [...byUser.values()]
    .filter((m) => m.display_name || m.goals.length)
    .sort((a, b) => b.goals.length - a.goals.length);

  if (!members.length) {
    $("cards").innerHTML = `<p class="empty">まだ誰も書いていません。</p>`;
    $("lists").innerHTML = "";
    return;
  }

  $("cards").innerHTML = members.map((m, i) => {
    const n = m.goals.filter((g) => g.goal.trim()).length;
    const doing = m.goals.filter((g) => g.status === "進行中").length;
    const done = m.goals.filter((g) => g.status === "達成").length;
    const pct = Math.min(100, Math.round((n / 30) * 100));
    const left = n < 30 ? `30個まであと${30 - n}個` : n > 50 ? "50個超" : "30〜50個 達成";
    return `<a class="card" href="#m${i}">
      <div class="name">${esc(m.display_name || "（名前未設定）")}</div>
      <div class="nums">目標 ${n}個 ／ 進行中 ${doing} ／ 達成 ${done}</div>
      <div class="bar"><span style="width:${pct}%"></span></div>
      <div class="left">${left}</div></a>`;
  }).join("");

  $("lists").innerHTML = members.map((m, i) => {
    const rows = m.goals.filter((g) => g.goal.trim()).map((g, j) => `<tr>
      <td class="no">${j + 1}</td>
      <td>${esc(g.goal)}${g.memo ? `<span class="memo">${esc(g.memo)}</span>` : ""}</td>
      <td class="due">${fmtDate(g.due)}</td>
      <td class="cat">${esc(g.category)}</td>
      <td><span class="chip ${STATUS_CLASS[g.status] || ""}">${esc(g.status)}</span></td></tr>`).join("");
    return `<section class="member" id="m${i}">
      <h3>${esc(m.display_name || "（名前未設定）")}</h3>
      <div class="meta">${m.declared_on ? "宣言日 " + fmtDate(m.declared_on) : ""}</div>
      ${rows ? `<table class="view"><thead><tr><th>No.</th><th>目標</th><th class="due">期限</th><th class="cat">カテゴリ</th><th>ステータス</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="empty">まだ目標がありません。</p>`}
    </section>`;
  }).join("");
}

// ---------- ログイン ----------
function renderAccount() {
  if (session) {
    $("account").innerHTML = `${esc(session.user.email)}<br><button class="ghost small" id="logout">ログアウト</button>`;
    $("logout").onclick = async () => {
      if (dirty && !confirm("保存していない変更があります。ログアウトしますか？")) return;
      await sb.auth.signOut();
    };
    $("loginBox").hidden = true;
    $("mine").hidden = false;
  } else {
    $("account").innerHTML = `<a href="#loginBox" id="toLogin">メンバーのログイン</a>`;
    $("loginBox").hidden = false;
    $("mine").hidden = true;
  }
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  $("loginBtn").disabled = true;
  $("loginMsg").className = "msg";
  $("loginMsg").textContent = "送信中…";
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname },
  });
  $("loginBtn").disabled = false;
  if (error) {
    $("loginMsg").className = "msg err";
    $("loginMsg").textContent = /signup|not allowed|not found/i.test(error.message)
      ? "このアドレスは招待されていません。主催者に招待を頼んでください。"
      : "送信できませんでした：" + error.message;
  } else {
    $("loginMsg").textContent = "ログイン用のリンクをメールで送りました。メールを開いてリンクを押してください。";
  }
});

// ---------- 自分の目標の編集 ----------
async function loadMine() {
  const uid = session.user.id;
  const [{ data: prof }, { data: goals }] = await Promise.all([
    sb.from("profiles").select("display_name, declared_on").eq("user_id", uid).maybeSingle(),
    sb.from("goals").select("id, position, goal, due, category, status, memo").eq("user_id", uid).order("position"),
  ]);
  $("displayName").value = prof?.display_name || "";
  $("declaredOn").value = prof?.declared_on || "";
  myRows = (goals || []).map((g) => ({ ...g }));
  deletedIds = [];
  if (!myRows.length) for (let i = 0; i < 3; i++) myRows.push(blankRow());
  dirty = false;
  renderEditor();
}

function blankRow() {
  return { id: null, goal: "", due: "2027-12-31", category: "", status: "未着手", memo: "" };
}

function options(list, value, blank) {
  return (blank ? `<option value=""></option>` : "") +
    list.map((v) => `<option${v === value ? " selected" : ""}>${esc(v)}</option>`).join("");
}

function renderEditor() {
  $("editRows").innerHTML = myRows.map((r, i) => `<tr data-i="${i}">
    <td class="no">${i + 1}</td>
    <td class="goalcell"><textarea data-f="goal" rows="1" placeholder="例：月に1冊、本を読み切る：年間12冊">${esc(r.goal)}</textarea></td>
    <td><input data-f="due" type="date" value="${esc(r.due || "")}"></td>
    <td><select data-f="category">${options(CATEGORIES, r.category, true)}</select></td>
    <td><select data-f="status">${options(STATUSES, r.status, false)}</select></td>
    <td class="memocell"><textarea data-f="memo" rows="1">${esc(r.memo || "")}</textarea></td>
    <td><button class="ghost small" data-del="${i}" title="この目標を消す">削除</button></td>
  </tr>`).join("");
  updateCounter();
}

function updateCounter() {
  const n = myRows.filter((r) => r.goal.trim()).length;
  $("counter").textContent = n < 30 ? `${n}個（30個まであと${30 - n}個）` : n > 50 ? `${n}個（50個超）` : `${n}個（30〜50個 OK）`;
}

$("editRows").addEventListener("input", (e) => {
  const f = e.target.dataset.f;
  if (!f) return;
  const i = +e.target.closest("tr").dataset.i;
  myRows[i][f] = e.target.value;
  dirty = true;
  if (f === "goal") updateCounter();
});

$("editRows").addEventListener("click", (e) => {
  const i = e.target.dataset.del;
  if (i === undefined) return;
  const r = myRows[+i];
  if (r.goal.trim() && !confirm(`「${r.goal}」を消しますか？（保存するまで確定しません）`)) return;
  if (r.id) deletedIds.push(r.id);
  myRows.splice(+i, 1);
  dirty = true;
  renderEditor();
});

$("addRow").onclick = () => {
  myRows.push(blankRow());
  dirty = true;
  renderEditor();
  const last = $("editRows").lastElementChild?.querySelector("textarea");
  last?.focus();
};

["displayName", "declaredOn"].forEach((id) => $(id).addEventListener("input", () => (dirty = true)));

$("saveAll").onclick = async () => {
  const uid = session.user.id;
  const name = $("displayName").value.trim();
  const msg = $("saveMsg");
  msg.className = "msg";
  if (!name) {
    msg.className = "msg err";
    msg.textContent = "表示名を入れてください。";
    $("displayName").focus();
    return;
  }
  $("saveAll").disabled = true;
  msg.textContent = "保存中…";
  try {
    const { error: pe } = await sb.from("profiles").upsert({
      user_id: uid, display_name: name, declared_on: $("declaredOn").value || null,
    });
    if (pe) throw pe;

    if (deletedIds.length) {
      const { error } = await sb.from("goals").delete().in("id", deletedIds);
      if (error) throw error;
    }

    const kept = myRows.filter((r) => r.goal.trim() || r.id);
    const toRow = (r, pos) => ({
      user_id: uid, position: pos, goal: r.goal.trim(), due: r.due || null,
      category: r.category || null, status: r.status || "未着手", memo: (r.memo || "").trim() || null,
    });
    const existing = [], fresh = [];
    kept.forEach((r, i) => (r.id ? existing.push({ id: r.id, ...toRow(r, i + 1) }) : fresh.push(toRow(r, i + 1))));
    if (existing.length) {
      const { error } = await sb.from("goals").upsert(existing);
      if (error) throw error;
    }
    if (fresh.length) {
      const { error } = await sb.from("goals").insert(fresh);
      if (error) throw error;
    }
    msg.textContent = "保存しました。";
    await loadMine();
    await loadPublic();
  } catch (err) {
    msg.className = "msg err";
    msg.textContent = "保存できませんでした：" + (err.message || err);
  } finally {
    $("saveAll").disabled = false;
  }
};

window.addEventListener("beforeunload", (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ""; }
});

// ---------- 起動 ----------
sb.auth.onAuthStateChange((_event, s) => {
  const changed = (s?.user?.id || null) !== (session?.user?.id || null);
  session = s;
  if (changed) {
    renderAccount();
    if (session) loadMine();
  }
});

const { data } = await sb.auth.getSession();
session = data.session;
renderAccount();
if (session) loadMine();
loadPublic();
