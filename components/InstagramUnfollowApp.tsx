"use client";

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type {
  AnalysisResult,
  InstagramListResponse,
  InstagramProfileResponse,
  InstagramUser,
  ProgressState,
  RelationshipCategory,
  TargetProfile,
} from "../lib/instagram/types";
import { compareUserLists } from "../lib/instagram/relationships";
import { normalizeUsername, userKey } from "../lib/instagram/validation";

type TabKey = RelationshipCategory;
const TABS: TabKey[] = ["unfollowers", "fans", "mutuals", "following", "followers"];
const TAB_LABELS: Record<TabKey, string> = {
  unfollowers: "🚫 Unfollowers",
  fans: "🌟 Fans",
  mutuals: "🤝 Mutuals",
  following: "Following",
  followers: "Followers",
};

interface Props {
  initialResult: AnalysisResult | null;
  initialProfile: TargetProfile | null;
  initialUsername: string;
  initialError: string | null;
}

interface ProgressUpdate {
  phase?: string;
  percent?: number;
  following?: string | number;
  followers?: string | number;
  targetFollowing?: string | number;
  targetFollowers?: string | number;
  page?: string;
  log?: string;
}

const emptyProgress: ProgressState = {
  phase: "Menghubungkan ke Instagram API...",
  percent: 0,
  following: 0,
  followers: 0,
  targetFollowing: "—",
  targetFollowers: "—",
  page: "Standby",
  log: "Menyiapkan koneksi...",
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Respons server tidak valid (HTTP ${response.status})`);
  }
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "message" in data
        ? String((data as { message?: unknown }).message || "")
        : "";
    throw new Error(message || `HTTP ${response.status}`);
  }
  return data as T;
}

function appendUniqueUsers(
  target: InstagramUser[],
  rawUsers: unknown,
  seenIds: Set<string>,
): InstagramUser[] {
  const added: InstagramUser[] = [];
  if (!Array.isArray(rawUsers)) return added;
  for (const value of rawUsers) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const user = value as InstagramUser;
    const key = userKey(user);
    if (!key || seenIds.has(key)) continue;
    seenIds.add(key);
    target.push(user);
    added.push(user);
  }
  return added;
}

function profileFromUser(user: InstagramUser, fallbackUsername: string): TargetProfile {
  const followerCount = Number(user.edge_followed_by?.count || user.follower_count || 0);
  const followingCount = Number(user.edge_follow?.count || user.following_count || 0);
  return {
    id: String(user.id),
    username: String(user.username || fallbackUsername),
    full_name: String(user.full_name || ""),
    profile_pic_url: String(user.profile_pic_url || ""),
    is_private: Boolean(user.is_private),
    is_verified: Boolean(user.is_verified),
    follower_count: Number.isFinite(followerCount) ? followerCount : 0,
    following_count: Number.isFinite(followingCount) ? followingCount : 0,
  };
}

function formatNumber(value: string | number): string {
  return typeof value === "number" ? value.toLocaleString("id-ID") : value;
}

function instagramProfileUrl(username?: string): string {
  return `https://www.instagram.com/${encodeURIComponent(username || "")}/`;
}

export default function InstagramUnfollowApp({
  initialResult,
  initialProfile,
  initialUsername,
  initialError,
}: Props) {
  const [sessionid, setSessionid] = useState("");
  const [username, setUsername] = useState(initialUsername);
  const [rememberSession, setRememberSession] = useState(true);
  const [data, setData] = useState<AnalysisResult | null>(initialResult);
  const [targetProfile, setTargetProfile] = useState<TargetProfile | null>(initialProfile);
  const [error, setError] = useState(initialError || "");
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [busy, setBusy] = useState(false);
  const [currentTab, setCurrentTab] = useState<TabKey>("unfollowers");
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("ig_sessionid");
      // The browser-only value must be loaded after hydration to avoid leaking it into SSR.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setSessionid(saved);
    } catch {
      // Browser privacy settings may disable localStorage.
    }
  }, []);

  useEffect(() => {
    if (!helpOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHelpOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [helpOpen]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2_500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function updateProgress(update: ProgressUpdate) {
    setProgress((current) => ({ ...(current || emptyProgress), ...update }));
  }

  function storeSession(value: string) {
    try {
      if (value) window.localStorage.setItem("ig_sessionid", value);
      else window.localStorage.removeItem("ig_sessionid");
    } catch {
      // Browser privacy settings may disable localStorage.
    }
  }

  async function startScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanSession = sessionid.trim();
    let cleanUsername: string;
    try {
      cleanUsername = normalizeUsername(username);
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : "Username tidak valid");
      return;
    }
    if (!cleanSession || !cleanUsername) {
      setError("Session ID dan Username target wajib diisi!");
      return;
    }

    storeSession(rememberSession ? cleanSession : "");
    setBusy(true);
    setError("");
    setData(null);
    setTargetProfile(null);
    setSearch("");
    setCurrentTab("unfollowers");
    setProgress({
      ...emptyProgress,
      phase: "Menghubungkan ke Instagram...",
      percent: 5,
      log: `Mencari data akun @${cleanUsername}...`,
      page: "Memulai",
    });

    try {
      const headers = { "x-sessionid": cleanSession };
      const profileData = await fetchJson<InstagramProfileResponse>(
        `/api/ig/users/web_profile_info?username=${encodeURIComponent(cleanUsername)}`,
        { headers },
      );
      const user = profileData.data?.user;
      if (!user?.id) throw new Error("Username tidak ditemukan");
      const profile = profileFromUser(user, cleanUsername);
      const estimatedFollowing = profile.following_count;
      const estimatedFollowers = profile.follower_count;
      setTargetProfile(profile);
      updateProgress({
        phase: `Akun @${profile.username} ditemukan`,
        percent: 10,
        targetFollowing: formatNumber(estimatedFollowing),
        targetFollowers: formatNumber(estimatedFollowers),
        log: `Akun @${profile.username} ditemukan!`,
      });

      const following: InstagramUser[] = [];
      const followingIds = new Set<string>();
      const followingCursors = new Set<string>();
      let maxId: string | null = null;
      let page = 0;
      do {
        page += 1;
        if (maxId) {
          maxId = String(maxId);
          if (followingCursors.has(maxId)) {
            throw new Error("Pagination following berulang. Coba lagi nanti.");
          }
          followingCursors.add(maxId);
        }
        let url = `/api/ig/friendships/${encodeURIComponent(String(user.id))}/following?count=200`;
        if (maxId) url += `&max_id=${encodeURIComponent(maxId)}`;
        const response = await fetchJson<InstagramListResponse>(url, { headers });
        const chunk = appendUniqueUsers(following, response.users, followingIds);
        const totalFetched = following.length;
        const totalTarget = Math.max(1, estimatedFollowing + estimatedFollowers);
        const percent = Math.max(10, Math.min(94, Math.round(10 + (totalFetched / totalTarget) * 84)));
        updateProgress({
          phase: "Mengambil Following...",
          percent,
          following: formatNumber(following.length),
          followers: 0,
          targetFollowing: formatNumber(estimatedFollowing),
          targetFollowers: formatNumber(estimatedFollowers),
          page: `Halaman ${page}`,
          log: `Following: Halaman ${page} (+${chunk.length}, total ${following.length})`,
        });
        maxId = response.next_max_id == null ? null : String(response.next_max_id);
        await delay(400);
      } while (maxId);

      const followers: InstagramUser[] = [];
      const followerIds = new Set<string>();
      const followerCursors = new Set<string>();
      maxId = null;
      page = 0;
      do {
        page += 1;
        if (maxId) {
          maxId = String(maxId);
          if (followerCursors.has(maxId)) {
            throw new Error("Pagination followers berulang. Coba lagi nanti.");
          }
          followerCursors.add(maxId);
        }
        let url = `/api/ig/friendships/${encodeURIComponent(String(user.id))}/followers?count=50&search_surface=follow_list_page`;
        if (maxId) url += `&max_id=${encodeURIComponent(maxId)}`;
        const response = await fetchJson<InstagramListResponse>(url, { headers });
        const chunk = appendUniqueUsers(followers, response.users, followerIds);
        const totalFetched = following.length + followers.length;
        const totalTarget = Math.max(1, estimatedFollowing + estimatedFollowers);
        const percent = Math.max(10, Math.min(94, Math.round(10 + (totalFetched / totalTarget) * 84)));
        updateProgress({
          phase: "Mengambil Followers...",
          percent,
          following: formatNumber(following.length),
          followers: formatNumber(followers.length),
          targetFollowing: formatNumber(estimatedFollowing),
          targetFollowers: formatNumber(estimatedFollowers),
          page: `Halaman ${page}`,
          log: `Followers: Halaman ${page} (+${chunk.length}, total ${followers.length})`,
        });
        maxId = response.next_max_id == null ? null : String(response.next_max_id);
        await delay(400);
      } while (maxId);

      updateProgress({
        phase: "Menghitung Hasil...",
        percent: 95,
        log: "Menghitung perbandingan Unfollowers, Fans, dan Mutuals...",
      });
      const result = compareUserLists(followers, following);
      setData(result);
      updateProgress({
        phase: "✓ Selesai Menganalisis!",
        percent: 100,
        page: "Lengkap",
        log: `Selesai! Ditemukan ${result.unfollowers.length} unfollowers, ${result.fans.length} fans, ${result.mutuals.length} mutuals.`,
      });
      setToast("Analisis selesai! Data berhasil dimuat.");
      window.setTimeout(() => document.getElementById("resultsContainer")?.scrollIntoView({ behavior: "smooth" }), 300);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "Gagal terhubung ke server.");
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }

  async function copyText(text: string) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const fallback = document.createElement("textarea");
        fallback.value = text;
        fallback.setAttribute("readonly", "");
        fallback.style.position = "fixed";
        fallback.style.opacity = "0";
        document.body.appendChild(fallback);
        fallback.select();
        if (!document.execCommand("copy")) throw new Error("copy failed");
        fallback.remove();
      }
      setToast(`"${text}" tersalin ke clipboard!`);
    } catch {
      setToast("Gagal menyalin teks");
    }
  }

  function exportData(format: "csv" | "json") {
    const list = data?.[currentTab] || [];
    if (!list.length) {
      setToast("Tidak ada data untuk diekspor!");
      return;
    }
    const filename = `instagram_${currentTab}_${new Date().toISOString().slice(0, 10)}`;
    if (format === "json") {
      downloadFile(JSON.stringify(list, null, 2), "application/json;charset=utf-8", `${filename}.json`);
      setToast("Export JSON berhasil didownload!");
      return;
    }
    const headers = ["Username", "Full Name", "User ID / PK", "Is Verified", "Is Private", "Profile URL"];
    const rows = list.map((user) => [
      csvCell(user.username),
      csvCell(user.full_name),
      csvCell(user.pk ?? user.id),
      csvCell(user.is_verified ? "Yes" : "No"),
      csvCell(user.is_private ? "Yes" : "No"),
      csvCell(instagramProfileUrl(user.username)),
    ]);
    const content = "\uFEFF" + [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");
    downloadFile(content, "text/csv;charset=utf-8", `${filename}.csv`);
    setToast("Export CSV berhasil didownload!");
  }

  return (
    <>
      <div className="glow-orb glow-1" />
      <div className="glow-orb glow-2" />
      <div className="container">
        <header>
          <div className="brand-badge"><span className="dot" /><span>Instagram API &bull; Direct Session Engine</span></div>
          <h1 className="logo-title"><span aria-hidden="true">◎</span><span className="gradient-text">Instagram Unfollow</span></h1>
          <p className="subtitle">Analisis followers, following, dan temukan akun yang tidak follow back (unfollowers) dengan cepat dan akurat.</p>
        </header>

        <section className="glass-card form-card">
          <form id="checkForm" method="POST" action="/" onSubmit={startScan}>
            <div className="form-grid">
              <div className="input-group">
                <div className="label-row">
                  <label className="input-label" htmlFor="sessionid">🔑 Session ID Cookie</label>
                  <button type="button" className="help-btn" onClick={() => setHelpOpen(true)}>ⓘ Cara Ambil</button>
                </div>
                <div className="input-wrapper">
                  <span className="input-icon">▤</span>
                  <input
                    type="password"
                    id="sessionid"
                    name="sessionid"
                    className="custom-input"
                    placeholder="Contoh: 30869018875%3Axxx..."
                    value={sessionid}
                    onChange={(event) => setSessionid(event.target.value)}
                    required
                    autoComplete="off"
                  />
                </div>
              </div>
              <div className="input-group">
                <div className="label-row"><label className="input-label" htmlFor="username">👤 Username Target</label></div>
                <div className="input-wrapper">
                  <span className="input-icon">@</span>
                  <input
                    type="text"
                    id="username"
                    name="username"
                    className="custom-input"
                    placeholder="Username Instagram (tanpa @)"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    required
                    autoComplete="off"
                  />
                </div>
              </div>
            </div>
            <div className="form-options">
              <label className="checkbox-label">
                <input type="checkbox" id="rememberSession" checked={rememberSession} onChange={(event) => setRememberSession(event.target.checked)} />
                <span>Simpan Session ID di browser (LocalStorage)</span>
              </label>
            </div>
            <button type="submit" className="btn-submit" id="submitBtn" disabled={busy}>
              {busy ? "⟳ Sedang Menganalisis..." : "⌕ Mulai Analisis Akun"}
            </button>
          </form>
        </section>

        {progress && <ProgressCard progress={progress} />}
        {error && <ErrorAlert message={error} />}
        {data && (
          <ResultView
            data={data}
            targetProfile={targetProfile}
            currentTab={currentTab}
            setCurrentTab={setCurrentTab}
            search={search}
            setSearch={setSearch}
            onCopy={copyText}
            onExport={exportData}
          />
        )}
      </div>

      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
      <div className={`toast${toast ? " show" : ""}`} role="status"><span>✓</span><span>{toast || "Tersalin ke clipboard!"}</span></div>
      <footer><p>Instagram Unfollow &bull; Session ID diproses oleh server aplikasi ini dan tidak dibagikan ke browser lain.</p></footer>
    </>
  );
}

function ProgressCard({ progress }: { progress: ProgressState }) {
  return (
    <section className="glass-card progress-card visible" id="progressSection">
      <div className="progress-header"><div className="progress-status-badge"><span className="live-dot" /><span aria-live="polite">{progress.phase}</span></div><div className="progress-percent">{progress.percent}%</div></div>
      <div className="progress-track"><div className="progress-fill" style={{ width: `${progress.percent}%` }} /></div>
      <div className="progress-metrics-row">
        <Metric title="Following Diambil" value={progress.following} target={progress.targetFollowing} />
        <Metric title="Followers Diambil" value={progress.followers} target={progress.targetFollowers} />
        <div className="metric-pill"><span className="metric-pill-title">▤ Status Batch</span><span className="metric-pill-val" style={{ fontSize: "0.95rem" }}>{progress.page}</span></div>
      </div>
      <div className="progress-log"><span>ⓘ</span><span aria-live="polite">{progress.log}</span></div>
    </section>
  );
}

function Metric({ title, value, target }: { title: string; value: string | number; target: string | number }) {
  return <div className="metric-pill"><span className="metric-pill-title">● {title}</span><span className="metric-pill-val">{value} <small>/ {target}</small></span></div>;
}

function ErrorAlert({ message }: { message: string }) {
  return <div className="alert alert-error" role="alert"><div className="alert-icon">⚠</div><div><strong>Terjadi Kesalahan:</strong> {message}</div></div>;
}

interface ResultViewProps {
  data: AnalysisResult;
  targetProfile: TargetProfile | null;
  currentTab: TabKey;
  setCurrentTab: (tab: TabKey) => void;
  search: string;
  setSearch: (search: string) => void;
  onCopy: (text: string) => void;
  onExport: (format: "csv" | "json") => void;
}

function ResultView({ data, targetProfile, currentTab, setCurrentTab, search, setSearch, onCopy, onExport }: ResultViewProps) {
  const list = useMemo(() => data[currentTab] || [], [data, currentTab]);
  const query = search.toLowerCase().trim();
  const filtered = useMemo(
    () => list.filter((user) => `${user.username || ""} ${user.full_name || ""}`.toLowerCase().includes(query)),
    [list, query],
  );

  return (
    <div id="resultsContainer">
      {targetProfile && <TargetProfileCard profile={targetProfile} />}
      <div className="stats-grid">
        <StatCard tab="unfollowers" label="Unfollowers" value={data.unfollowers.length} tone="red" onClick={setCurrentTab} />
        <StatCard tab="fans" label="Fans (Belum Follback)" value={data.fans.length} tone="orange" onClick={setCurrentTab} />
        <StatCard tab="mutuals" label="Mutuals" value={data.mutuals.length} tone="green" onClick={setCurrentTab} />
        <StatCard tab="followers" label="Followers" value={data.followers.length} tone="purple" onClick={setCurrentTab} />
        <StatCard tab="following" label="Following" value={data.following.length} tone="blue" onClick={setCurrentTab} />
      </div>
      <div className="content-section">
        <div className="tabs-header-wrap"><div className="tabs-nav">
          {TABS.map((tab) => <button type="button" className={`tab-button${currentTab === tab ? " active" : ""}`} data-tab={tab} key={tab} onClick={() => setCurrentTab(tab)}><span>{TAB_LABELS[tab]}</span><span className="tab-badge">{data[tab].length}</span></button>)}
        </div></div>
        <div className="controls-bar">
          <div className="search-box"><span className="search-icon">⌕</span><input type="text" className="search-input" placeholder="Cari username atau nama..." value={search} onChange={(event) => setSearch(event.target.value)} /></div>
          <div className="export-group"><button type="button" className="btn-secondary" onClick={() => onExport("csv")}>⇩ Export CSV</button><button type="button" className="btn-secondary" onClick={() => onExport("json")}>⇩ Export JSON</button></div>
        </div>
        <div className="tab-panel" id={`panel-${currentTab}`}>
          <div className="user-grid">
            {filtered.length ? filtered.map((user, index) => <UserCard key={`${userKey(user) || "user"}-${index}`} user={user} onCopy={onCopy} />) : <div className="empty-state" style={{ gridColumn: "1 / -1" }}><div className="empty-icon">{list.length ? "🔍" : "✨"}</div><h3>{list.length ? "Pencarian Tidak Ditemukan" : "Daftar Kosong"}</h3><p>{list.length ? "Tidak ada pengguna yang cocok dengan kata kunci pencarian Anda." : "Tidak ada akun dalam kategori ini."}</p></div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function TargetProfileCard({ profile }: { profile: TargetProfile }) {
  return <div className="target-profile-card"><div className="target-info"><div className="target-avatar-ring"><Avatar user={profile} target /></div><div className="target-names"><h2>@{profile.username}{profile.is_verified && <span className="badge-icon badge-verified" title="Terverifikasi">✓</span>}{profile.is_private && <span className="badge-icon badge-private" title="Akun Privat">▣</span>}</h2><p>{profile.full_name || "Tidak ada nama lengkap"}</p></div></div><div className="target-action"><a href={instagramProfileUrl(profile.username)} target="_blank" rel="noopener noreferrer" className="btn-secondary">Buka di IG ↗</a></div></div>;
}

function StatCard({ tab, label, value, tone, onClick }: { tab: TabKey; label: string; value: number; tone: string; onClick: (tab: TabKey) => void }) {
  return <button type="button" className="stat-card" onClick={() => onClick(tab)}><div className="stat-header"><span>{label}</span><div className={`stat-icon ${tone}`}>●</div></div><div className="stat-value">{value}</div></button>;
}

function UserCard({ user, onCopy }: { user: InstagramUser; onCopy: (text: string) => void }) {
  const username = user.username || "";
  return <div className="user-card"><div className="user-left"><div className="user-avatar-wrap"><Avatar user={user} /></div><div className="user-details"><div className="user-username-row"><a href={instagramProfileUrl(username)} target="_blank" rel="noopener noreferrer" className="user-username-link">@{username || "unknown"}</a>{user.is_verified && <span className="badge-icon badge-verified" title="Verified">✓</span>}{user.is_private && <span className="badge-icon badge-private" title="Private Account">▣</span>}</div><div className="user-fullname">{user.full_name || "—"}</div></div></div><div className="user-actions"><button type="button" className="icon-btn" title="Salin @username" aria-label="Salin @username" onClick={() => onCopy(`@${username}`)}>▣</button><a href={instagramProfileUrl(username)} target="_blank" rel="noopener noreferrer" className="icon-btn" title="Buka Profil">↗</a></div></div>;
}

function Avatar({ user, target = false }: { user: InstagramUser | TargetProfile; target?: boolean }) {
  const [failed, setFailed] = useState(false);
  const username = user.username || "?";
  if (failed || !user.profile_pic_url) return <div className="avatar-fallback" style={target ? { width: 64, height: 64 } : undefined}>{username[0].toUpperCase()}</div>;
  return <img src={`/api/ig/img?url=${encodeURIComponent(user.profile_pic_url)}`} alt={username} className={target ? "target-avatar" : "user-avatar"} referrerPolicy="no-referrer" onError={() => setFailed(true)} />; // eslint-disable-line @next/next/no-img-element
}

function HelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <div className="modal-overlay active" role="dialog" aria-modal="true" aria-labelledby="helpModalTitle" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="modal-dialog"><div className="modal-header"><h3 id="helpModalTitle">ⓘ Cara Mengambil Cookie Session ID</h3><button type="button" className="modal-close" onClick={onClose}>&times;</button></div><div className="modal-body"><ModalStep number="1" title="Buka Instagram Web">Buka <a href="https://www.instagram.com" target="_blank" rel="noreferrer" style={{ color: "var(--ig-blue)" }}>instagram.com</a> dan pastikan Anda sudah login.</ModalStep><ModalStep number="2" title="Buka Developer Tools">Tekan <code>F12</code> atau pilih <em>Inspect</em> / <em>Periksa</em>.</ModalStep><ModalStep number="3" title="Buka Tab Application / Storage">Klik tab <strong>Application</strong> (Firefox: <strong>Storage</strong>).</ModalStep><ModalStep number="4" title="Salin Value Cookie sessionid">Buka <strong>Cookies</strong> → <code>https://www.instagram.com</code>, lalu salin value <strong>sessionid</strong>.<div className="code-block">Format: 30869018875%3Axxxxxxxxxx%3A...</div></ModalStep></div><div className="modal-footer"><button type="button" className="btn-secondary" onClick={onClose}>Saya Mengerti</button></div></div></div>;
}

function ModalStep({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return <div className="modal-step"><div className="step-num">{number}</div><div className="step-content"><strong>{title}</strong><p>{children}</p></div></div>;
}

function csvCell(value: unknown): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function downloadFile(content: string, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
