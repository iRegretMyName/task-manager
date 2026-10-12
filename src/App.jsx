import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const STORAGE_KEY = "task-manager-data";
const SPOTIFY_CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID;
const configuredSpotifyRedirectUri = import.meta.env.VITE_SPOTIFY_REDIRECT_URI;

const blankForm = {
  title: "",
  description: "",
  category: "General",
  priority: "Medium",
  dueDate: "",
  dueTime: "09:00",
};

const priorityStyles = {
  Low: "#3b82f6",
  Medium: "#8b5cf6",
  High: "#f97316",
  Urgent: "#ef4444",
};

const makeId = () =>
  crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const today = () => new Date().toISOString().slice(0, 10);

const getProgress = (task) => {
  const manual = Number(task.manualProgress || 0);

  if (!task.steps?.length) return manual;

  const checked = task.steps.filter((step) => step.completed).length;
  const stepProgress = Math.round((checked / task.steps.length) * 100);

  return Math.max(manual, stepProgress);
};

const isOverdue = (task) =>
  task.status !== "Completed" && task.dueDate && task.dueDate < today();

const base64Url = (buffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const getSpotifyRedirectUri = () =>
  configuredSpotifyRedirectUri || `${window.location.origin}/`;

const loadSavedTasks = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");

    return saved.map((task) => ({
      ...task,
      manualProgress: Number(task.manualProgress || 0),
      steps: Array.isArray(task.steps) ? task.steps : [],
    }));
  } catch {
    return [];
  }
};

async function getSpotifyChallenge() {
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(64)))
    .map((value) => characters[value % characters.length])
    .join("");

  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );

  sessionStorage.setItem("spotify_verifier", verifier);
  return base64Url(hash);
}

const loadSpotifyIframeApi = () => {
  if (window.SpotifyIframeApi) return Promise.resolve(window.SpotifyIframeApi);

  if (window.spotifyIframeApiPromise) {
    return window.spotifyIframeApiPromise;
  }

  window.spotifyIframeApiPromise = new Promise((resolve) => {
    window.onSpotifyIframeApiReady = (api) => {
      window.SpotifyIframeApi = api;
      resolve(api);
    };

    const script = document.createElement("script");
    script.src = "https://open.spotify.com/embed/iframe-api/v1";
    script.async = true;
    document.body.appendChild(script);
  });

  return window.spotifyIframeApiPromise;
};

function SpotifyEmbed({ uri, theme, onTrackEnded, controllerRef }) {
  const embedRef = useRef(null);
  const endedHandlerRef = useRef(onTrackEnded);

  useEffect(() => {
    endedHandlerRef.current = onTrackEnded;
  }, [onTrackEnded]);

  useEffect(() => {
    let disposed = false;
    let controller;

    loadSpotifyIframeApi().then((api) => {
      if (disposed || !embedRef.current) return;

      api.createController(
        embedRef.current,
        { uri, theme: theme === "dark" ? 1 : 0 },
        (createdController) => {
          if (disposed) {
            createdController.destroy?.();
            return;
          }

          controller = createdController;
          controllerRef.current = controller;
          controller.addListener("playback_update", (event) => {
            const data = event?.data;
            const ended =
              data &&
              !data.isPlaying &&
              data.duration > 0 &&
              data.position >= data.duration - 1000;

            if (ended) endedHandlerRef.current();
          });

          controller.loadUri(uri);
        }
      );
    });

    return () => {
      disposed = true;
      if (controllerRef.current === controller) controllerRef.current = null;
      controller?.destroy?.();
    };
  }, [controllerRef, theme, uri]);

  return <div ref={embedRef} className="player" />;
}

export default function TaskManager() {
  const [page, setPage] = useState("tasks");
  const [theme, setTheme] = useState(
    () => localStorage.getItem("task-manager-theme") || "light"
  );
  const [tasks, setTasks] = useState(loadSavedTasks);
  const [form, setForm] = useState(blankForm);
  const [activeTaskIndex, setActiveTaskIndex] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [newSteps, setNewSteps] = useState([]);

  const [spotifyToken, setSpotifyToken] = useState(
    () => sessionStorage.getItem("spotify_token") || ""
  );
  const [spotifyUser, setSpotifyUser] = useState(null);
  const [playlists, setPlaylists] = useState([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);
  const [selectedTrack, setSelectedTrack] = useState(null);
  const [spotifySearchQuery, setSpotifySearchQuery] = useState("");
  const [spotifySearchResults, setSpotifySearchResults] = useState([]);
  const [spotifySearchLoading, setSpotifySearchLoading] = useState(false);
  const [spotifySearchSubmitted, setSpotifySearchSubmitted] = useState(false);
  const [spotifySearchMessage, setSpotifySearchMessage] = useState("");
  const [spotifyMessage, setSpotifyMessage] = useState("");
  const [spotifyLoading, setSpotifyLoading] = useState(false);
  const [spotifyRetry, setSpotifyRetry] = useState(0);
  const spotifyControllerRef = useRef(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  }, [tasks]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("task-manager-theme", theme);
  }, [theme]);

  useEffect(() => {
    const finishSpotifyLogin = async () => {
      const query = new URLSearchParams(window.location.search);
      const code = query.get("code");
      const authorizationError = query.get("error");

      if (authorizationError) {
        sessionStorage.removeItem("spotify_token");
        sessionStorage.removeItem("spotify_verifier");
        setSpotifyToken("");
        setSpotifyUser(null);
        setPlaylists([]);
        setSelectedPlaylist(null);
        setSelectedTrack(null);
        setSpotifyMessage(
          query.get("error_description") || "Spotify sign-in was cancelled."
        );
        window.history.replaceState({}, document.title, window.location.pathname);
        return;
      }

      if (!code || spotifyToken || !SPOTIFY_CLIENT_ID) return;

      const verifier = sessionStorage.getItem("spotify_verifier");
      if (!verifier) {
        setSpotifyMessage("Spotify sign-in expired. Please try again.");
        window.history.replaceState({}, document.title, window.location.pathname);
        return;
      }

      try {
        const response = await fetch("https://accounts.spotify.com/api/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: SPOTIFY_CLIENT_ID,
            grant_type: "authorization_code",
            code,
            redirect_uri: getSpotifyRedirectUri(),
            code_verifier: verifier,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error_description || "Spotify login failed.");
        }

        if (!data.access_token) {
          throw new Error("Spotify did not return an access token.");
        }

        sessionStorage.setItem("spotify_token", data.access_token);
        setSpotifyToken(data.access_token);
        setSpotifyMessage("Spotify connected.");
      } catch (error) {
        setSpotifyMessage(error.message);
      } finally {
        sessionStorage.removeItem("spotify_verifier");
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    };

    finishSpotifyLogin();
  }, [spotifyToken]);

  useEffect(() => {
    if (!spotifyToken) return;

    const loadSpotify = async () => {
      setSpotifyLoading(true);
      setSpotifyMessage("");

      try {
        const headers = { Authorization: `Bearer ${spotifyToken}` };

        const [profileResponse, playlistsResponse] = await Promise.all([
          fetch("https://api.spotify.com/v1/me", { headers }),
          fetch("https://api.spotify.com/v1/me/playlists?limit=12", { headers }),
        ]);

        if (profileResponse.status === 401 || playlistsResponse.status === 401) {
          sessionStorage.removeItem("spotify_token");
          setSpotifyToken("");
          setSpotifyUser(null);
          setPlaylists([]);
          setSelectedPlaylist(null);
          setSelectedTrack(null);
          setSpotifyMessage("Spotify session expired. Please sign in again.");
          return;
        }

        if (!profileResponse.ok || !playlistsResponse.ok) {
          const failedResponse = !profileResponse.ok
            ? profileResponse
            : playlistsResponse;
          const errorData = await failedResponse.json().catch(() => ({}));
          throw new Error(
            errorData.error?.message || "Spotify could not load your account."
          );
        }

        const profile = await profileResponse.json();
        const playlistData = await playlistsResponse.json();
        const availablePlaylists = Array.isArray(playlistData.items)
          ? playlistData.items.filter((playlist) => playlist?.id)
          : [];

        setSpotifyUser(profile);
        setPlaylists(availablePlaylists);
        setSelectedPlaylist((current) =>
          availablePlaylists.some((playlist) => playlist.id === current?.id)
            ? current
            : availablePlaylists[0] || null
        );
      } catch (error) {
        setSpotifyMessage(error.message || "Spotify could not be loaded right now.");
      } finally {
        setSpotifyLoading(false);
      }
    };

    loadSpotify();
  }, [spotifyRetry, spotifyToken]);

  const metrics = useMemo(() => {
    const completed = tasks.filter(
      (task) => task.status === "Completed" || getProgress(task) === 100
    ).length;

    const totalSteps = tasks.reduce(
      (sum, task) => sum + task.steps.length,
      0
    );

    const completedSteps = tasks.reduce(
      (sum, task) =>
        sum + task.steps.filter((step) => step.completed).length,
      0
    );

    const progress = tasks.length
      ? Math.round(
          tasks.reduce((sum, task) => sum + getProgress(task), 0) /
            tasks.length
        )
      : 0;

    return {
      completed,
      totalSteps,
      completedSteps,
      progress,
      overdue: tasks.filter(isOverdue).length,
    };
  }, [tasks]);

  const activeTask = tasks[activeTaskIndex];

  const addTask = (event) => {
    event.preventDefault();

    if (!form.title.trim() || !form.dueDate) return;

    const task = {
      id: makeId(),
      ...form,
      title: form.title.trim(),
      description: form.description.trim(),
      category: form.category.trim() || "General",
      status: "Not Started",
      manualProgress: 0,
      steps: [],
      createdAt: new Date().toISOString(),
      completedAt: null,
    };

    setTasks((current) => [task, ...current]);
    setActiveTaskIndex(0);
    setForm(blankForm);
  };

  const updateTask = (taskId, updates) => {
    setTasks((current) =>
      current.map((task) => {
        if (task.id !== taskId) return task;

        const updated = { ...task, ...updates };
        const progress = getProgress(updated);

        return {
          ...updated,
          status: progress === 100 ? "Completed" : updated.status,
          completedAt:
            progress === 100
              ? updated.completedAt || new Date().toISOString()
              : null,
        };
      })
    );
  };

  const deleteTask = (taskId) => {
    const deletedIndex = tasks.findIndex((task) => task.id === taskId);

    if (deletedIndex < activeTaskIndex || activeTaskIndex === tasks.length - 1) {
      setActiveTaskIndex((index) => Math.max(0, index - 1));
    }

    setTasks((current) => current.filter((task) => task.id !== taskId));
  };

  const toggleStep = (taskId, stepId) => {
    setTasks((current) =>
      current.map((task) => {
        if (task.id !== taskId) return task;

        const updated = {
          ...task,
          steps: task.steps.map((step) =>
            step.id === stepId
              ? { ...step, completed: !step.completed }
              : step
          ),
        };

        const progress = getProgress(updated);

        return {
          ...updated,
          status: progress === 100 ? "Completed" : "In Progress",
          completedAt: progress === 100 ? new Date().toISOString() : null,
        };
      })
    );
  };

  const generateSteps = () => {
    if (!prompt.trim()) return;

    const goal = prompt.trim().replace(/[.!?]+$/, "");

    setNewSteps([
      `Define what success looks like for: ${goal}`,
      "Gather what you need before starting",
      "Complete the first focused action",
      "Finish the main work",
      "Review and improve the final result",
    ]);
  };

  const addStepsToTask = () => {
    if (!activeTask || !newSteps.length) return;

    updateTask(activeTask.id, {
      steps: [
        ...activeTask.steps,
        ...newSteps.map((text) => ({
          id: makeId(),
          text,
          completed: false,
        })),
      ],
    });

    setPrompt("");
    setNewSteps([]);
  };

  const loginSpotify = async () => {
    if (!SPOTIFY_CLIENT_ID) {
      setSpotifyMessage(
        "Create a .env file and add VITE_SPOTIFY_CLIENT_ID first."
      );
      return;
    }

    setSpotifyMessage("");
    setSpotifyLoading(true);

    try {
      const challenge = await getSpotifyChallenge();
      const redirectUri = getSpotifyRedirectUri();

      const parameters = new URLSearchParams({
        client_id: SPOTIFY_CLIENT_ID,
        response_type: "code",
        redirect_uri: redirectUri,
        code_challenge_method: "S256",
        code_challenge: challenge,
        scope:
          "user-read-private user-read-email playlist-read-private playlist-read-collaborative",
      });

      window.location.assign(
        `https://accounts.spotify.com/authorize?${parameters.toString()}`
      );
    } catch (error) {
      sessionStorage.removeItem("spotify_verifier");
      setSpotifyLoading(false);
      setSpotifyMessage(error.message || "Spotify sign-in could not start.");
    }
  };

  const searchSpotify = async (event) => {
    event.preventDefault();

    const query = spotifySearchQuery.trim();
    if (!query || !spotifyToken) return;

    setSpotifySearchLoading(true);
    setSpotifySearchSubmitted(true);
    setSpotifySearchMessage("");

    try {
      const response = await fetch(
        `https://api.spotify.com/v1/search?type=track&limit=10&q=${encodeURIComponent(query)}`,
        { headers: { Authorization: `Bearer ${spotifyToken}` } }
      );
      const data = await response.json().catch(() => ({}));

      if (response.status === 401) {
        logoutSpotify();
        setSpotifyMessage("Spotify session expired. Please sign in again.");
        return;
      }

      if (!response.ok) {
        throw new Error(data.error?.message || "Spotify search failed.");
      }

      const tracks = Array.isArray(data.tracks?.items)
        ? data.tracks.items.filter((track) => track?.id)
        : [];
      const artistIds = [
        ...new Set(
          tracks.flatMap((track) =>
            track.artists?.map((artist) => artist.id).filter(Boolean) || []
          )
        ),
      ];
      const artistResponse = artistIds.length
        ? await fetch(
            `https://api.spotify.com/v1/artists?ids=${artistIds.join(",")}`,
            { headers: { Authorization: `Bearer ${spotifyToken}` } }
          )
        : null;
      const artistData = artistResponse?.ok
        ? await artistResponse.json()
        : { artists: [] };
      const genresByArtist = new Map(
        (artistData.artists || []).map((artist) => [artist.id, artist.genres || []])
      );

      setSpotifySearchResults(
        tracks.map((track) => ({
          ...track,
          genres: [
            ...new Set(
              track.artists?.flatMap(
                (artist) => genresByArtist.get(artist.id) || []
              ) || []
            ),
          ],
        }))
      );
    } catch (error) {
      setSpotifySearchResults([]);
      setSpotifySearchMessage(
        error.message || "Spotify search is unavailable right now."
      );
    } finally {
      setSpotifySearchLoading(false);
    }
  };

  const handleTrackEnded = useCallback(() => {
    setSelectedTrack((currentTrack) => {
      if (!currentTrack) return currentTrack;

      const currentGenres = currentTrack.genres || [];
      const matchingTrack = spotifySearchResults.find(
        (track) =>
          track.id !== currentTrack.id &&
          currentGenres.some((genre) => track.genres?.includes(genre))
      );
      const nextTrack =
        matchingTrack ||
        spotifySearchResults.find((track) => track.id !== currentTrack.id);

      return nextTrack || currentTrack;
    });
  }, [spotifySearchResults]);

  const playSelectedTrack = () => {
    if (!spotifyControllerRef.current) {
      setSpotifyMessage("Spotify player is still loading. Try again in a moment.");
      return;
    }

    try {
      spotifyControllerRef.current.play();
    } catch {
      setSpotifyMessage("Spotify could not start this song. Use the player controls below.");
    }
  };

  const logoutSpotify = () => {
    sessionStorage.removeItem("spotify_token");
    setSpotifyToken("");
    setSpotifyUser(null);
    setPlaylists([]);
    setSelectedPlaylist(null);
    setSelectedTrack(null);
    setSpotifySearchResults([]);
    setSpotifySearchQuery("");
    setSpotifySearchSubmitted(false);
    setSpotifySearchMessage("");
    setSpotifyMessage("Spotify disconnected.");
  };

  return (
    <div className="app">
      <style>{`
        * { box-sizing: border-box; }

        body {
          margin: 0;
          overflow: hidden;
          background: #eaf0f7;
        }

        button, input, textarea, select {
          font: inherit;
        }

        button {
          cursor: pointer;
          border: 0;
          border-radius: 10px;
          padding: 9px 12px;
          font-weight: 700;
          transition: .16s ease;
        }

        button:hover:not(:disabled) {
          transform: translateY(-1px);
        }

        button:disabled {
          cursor: not-allowed;
          opacity: .45;
        }

        .app {
          --page-background: #eaf0f7;
          --app-text: #172033;
          --surface: rgba(255, 255, 255, .86);
          --surface-strong: #f8fafc;
          --surface-muted: #f1f5f9;
          --border-color: rgba(203, 213, 225, .9);
          --input-border: #cbd5e1;
          --muted-text: #64748b;
          --body-text: #334155;
          width: 100vw;
          max-width: none;
          height: 100dvh;
          min-height: 100svh;
          max-height: none;
          margin: 0;
          padding: clamp(12px, 1.5vw, 24px);
          overflow: hidden;
          color: var(--app-text);
          background:
            radial-gradient(circle at top left, rgba(147, 197, 253, .55), transparent 31%),
            radial-gradient(circle at bottom right, rgba(196, 181, 253, .45), transparent 28%),
            var(--page-background);
          font-family: Inter, Arial, sans-serif;
        }

        :root[data-theme="dark"] .app {
          --page-background: #0f172a;
          --app-text: #e2e8f0;
          --surface: rgba(30, 41, 59, .9);
          --surface-strong: #1e293b;
          --surface-muted: #273449;
          --border-color: rgba(100, 116, 139, .55);
          --input-border: #475569;
          --muted-text: #94a3b8;
          --body-text: #cbd5e1;
        }

        .layout {
          width: 100%;
          height: 100%;
          min-width: 0;
          display: grid;
          grid-template-rows: auto minmax(0, 1fr);
          gap: 14px;
        }

        .app h1,
        .app h2,
        .app h3 {
          color: var(--app-text);
        }

        .topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
        }

        .topbar-actions {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .tabs {
          display: flex;
          gap: 8px;
        }

        .tab {
          color: var(--muted-text);
          background: var(--surface);
          border: 1px solid var(--input-border);
        }

        .tab.active,
        .primary {
          color: white;
          background: linear-gradient(135deg, #2563eb, #5b4bc4);
        }

        .secondary {
          color: #14532d;
          background: #dcfce7;
          border: 1px solid #86efac;
        }

        .danger {
          color: #991b1b;
          background: #fee2e2;
          border: 1px solid #fca5a5;
        }

        .page-title {
          margin: 0;
          font-size: clamp(1.1rem, 1.8vw, 1.65rem);
        }

        .page {
          min-width: 0;
          min-height: 0;
        }

        .task-page {
          display: grid;
          grid-template-columns: minmax(260px, 4fr) minmax(360px, 7fr) minmax(240px, 4fr);
          gap: 14px;
        }

        .spotify-page {
          display: grid;
          grid-template-columns: minmax(300px, 5fr) minmax(400px, 9fr);
          gap: 14px;
        }

        .card {
          min-width: 0;
          min-height: 0;
          overflow: hidden;
          padding: clamp(14px, 1.3vw, 20px);
          border: 1px solid var(--border-color);
          border-radius: 18px;
          background: var(--surface);
          box-shadow: 0 16px 38px rgba(53, 75, 109, .12);
        }

        h2, h3, p { margin-top: 0; }
        h2 { font-size: 1rem; margin-bottom: 10px; }
        h3 { font-size: 1.08rem; margin-bottom: 5px; }

        .muted {
          color: var(--muted-text);
          font-size: .8rem;
        }

        .form, .prompt-panel {
          display: grid;
          gap: 9px;
        }

        .form-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 9px;
        }

        .full { grid-column: 1 / -1; }

        input, textarea, select {
          width: 100%;
          min-width: 0;
          padding: 9px 10px;
          color: var(--app-text);
          border: 1px solid var(--input-border);
          border-radius: 9px;
          background: var(--surface-strong);
        }

        textarea {
          min-height: 52px;
          resize: none;
        }

        .composer {
          display: grid;
          align-content: start;
          gap: 17px;
        }

        .prompt-panel {
          padding-top: 15px;
          border-top: 1px solid var(--border-color);
        }

        .step-preview {
          margin: 0;
          padding-left: 19px;
          color: var(--body-text);
          font-size: .78rem;
          line-height: 1.5;
        }

        .task-card {
          height: 100%;
          display: grid;
          grid-template-rows: auto auto auto 1fr auto;
          gap: 11px;
          border-left: 5px solid var(--priority);
          padding-left: 14px;
        }

        .task-header,
        .row,
        .task-footer {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .task-header,
        .task-footer {
          justify-content: space-between;
        }

        .badge {
          display: inline-block;
          padding: 3px 8px;
          color: #1e40af;
          border-radius: 99px;
          background: #dbeafe;
          font-size: .7rem;
        }

        .description {
          color: var(--muted-text);
          font-size: .85rem;
          line-height: 1.4;
          display: -webkit-box;
          overflow: hidden;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 2;
        }

        .progress-track {
          height: 10px;
          overflow: hidden;
          border-radius: 99px;
          background: var(--surface-muted);
        }

        .progress-fill {
          height: 100%;
          border-radius: inherit;
          background: linear-gradient(90deg, #2563eb, #7c3aed);
        }

        .range {
          padding: 0;
          accent-color: #2563eb;
        }

        .steps {
          display: grid;
          align-content: start;
          gap: 8px;
          overflow: hidden;
        }

        .step {
          display: flex;
          align-items: center;
          gap: 8px;
          color: var(--body-text);
          font-size: .83rem;
        }

        .step input {
          width: auto;
          accent-color: #2563eb;
        }

        .step.done {
          color: #94a3b8;
          text-decoration: line-through;
        }

        .overdue {
          color: #dc2626;
          font-size: .78rem;
        }

        .pager {
          display: flex;
          align-items: center;
          gap: 7px;
        }

        .pager button {
          padding: 6px 9px;
          color: #1e40af;
          background: #dbeafe;
        }

        .metrics {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 9px;
        }

        .metric {
          padding: 10px;
          border: 1px solid var(--border-color);
          border-radius: 11px;
          background: var(--surface-strong);
        }

        .metric strong {
          display: block;
          margin: 3px 0;
          font-size: 1.3rem;
        }

        .chart {
          display: grid;
          place-items: center;
          margin: 12px 0;
        }

        .chart-wrap {
          position: relative;
          display: grid;
          place-items: center;
        }

        .chart-ring {
          transform: rotate(-90deg);
          transform-origin: 65px 65px;
        }

        .chart-label {
          position: absolute;
          text-align: center;
        }

        .chart-label strong {
          display: block;
          font-size: 1.45rem;
        }

        .empty {
          height: 100%;
          display: grid;
          place-items: center;
          text-align: center;
          color: var(--muted-text);
        }

        .spotify-profile {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .spotify-error {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin: 12px 0;
          padding: 10px;
          color: #991b1b;
          border: 1px solid #fca5a5;
          border-radius: 10px;
          background: #fee2e2;
          font-size: .8rem;
        }

        .avatar {
          width: 46px;
          height: 46px;
          border-radius: 50%;
          object-fit: cover;
          background: #dbeafe;
        }

        .playlist-list {
          display: grid;
          gap: 8px;
          margin-top: 14px;
        }

        .spotify-search {
          display: grid;
          gap: 8px;
          margin-top: 18px;
          padding-top: 14px;
          border-top: 1px solid var(--border-color);
        }

        .search-row {
          display: flex;
          gap: 8px;
        }

        .search-row button {
          flex: 0 0 auto;
        }

        .spotify-search-message {
          margin: 0;
          color: #dc2626;
          font-size: .8rem;
        }

        .track-list {
          display: grid;
          gap: 8px;
        }

        .track {
          display: flex;
          align-items: center;
          gap: 9px;
          padding: 7px;
          border-radius: 10px;
          background: var(--surface-muted);
        }

        .track.selected {
          outline: 2px solid #60a5fa;
          background: #eff6ff;
        }

        .track-cover {
          width: 39px;
          height: 39px;
          flex: 0 0 auto;
          object-fit: cover;
          border-radius: 6px;
          background: #cbd5e1;
        }

        .track-info {
          min-width: 0;
          flex: 1;
        }

        .playlist {
          display: flex;
          align-items: center;
          gap: 9px;
          padding: 7px;
          border-radius: 10px;
          background: var(--surface-muted);
        }

        .playlist.selected {
          outline: 2px solid #60a5fa;
          background: #eff6ff;
        }

        .playlist-cover {
          width: 39px;
          height: 39px;
          object-fit: cover;
          border-radius: 6px;
          background: #cbd5e1;
        }

        .playlist-info {
          min-width: 0;
          flex: 1;
        }

        .playlist-name {
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
          font-size: .84rem;
        }

        .playlist button {
          padding: 6px 8px;
          color: white;
          background: #2563eb;
        }

        .player {
          width: 100%;
          height: min(440px, 65dvh);
          border: 0;
          border-radius: 15px;
        }

        .player iframe {
          width: 100%;
          height: 100%;
          border: 0;
          border-radius: inherit;
        }

        @media (max-width: 1000px) {
          .task-page {
            grid-template-columns: minmax(250px, 1fr) minmax(0, 1.5fr);
          }

          .insights {
            display: none;
          }
        }

        @media (max-width: 700px) {
          .task-page,
          .spotify-page {
            grid-template-columns: 1fr;
          }

          .composer,
          .spotify-page > :first-child {
            display: none;
          }
        }
      `}</style>

      <div className="layout">
        <header className="topbar">
          <div className="tabs">
            <button
              type="button"
              className={`tab ${page === "tasks" ? "active" : ""}`}
              onClick={() => setPage("tasks")}
            >
              Task Manager
            </button>

            <button
              type="button"
              className={`tab ${page === "spotify" ? "active" : ""}`}
              onClick={() => setPage("spotify")}
            >
              Spotify
            </button>
          </div>

          <h1 className="page-title">
            {page === "tasks" ? "Task Manager" : "Spotify"}
          </h1>

          <div className="topbar-actions">
            <button
              type="button"
              className="tab"
              aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              {theme === "light" ? "Dark mode" : "Light mode"}
            </button>
          </div>
        </header>

        {page === "tasks" ? (
          <main className="page task-page">
            <section className="card composer">
              <div>
                <h2>Create task</h2>

                <form className="form" onSubmit={addTask}>
                  <div className="form-grid">
                    <input
                      required
                      className="full"
                      placeholder="Task title"
                      value={form.title}
                      onChange={(event) =>
                        setForm({ ...form, title: event.target.value })
                      }
                    />

                    <textarea
                      className="full"
                      placeholder="Notes"
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                    />

                    <input
                      placeholder="Category"
                      value={form.category}
                      onChange={(event) =>
                        setForm({ ...form, category: event.target.value })
                      }
                    />

                    <select
                      value={form.priority}
                      onChange={(event) =>
                        setForm({ ...form, priority: event.target.value })
                      }
                    >
                      <option>Low</option>
                      <option>Medium</option>
                      <option>High</option>
                      <option>Urgent</option>
                    </select>

                    <input
                      required
                      type="date"
                      value={form.dueDate}
                      onChange={(event) =>
                        setForm({ ...form, dueDate: event.target.value })
                      }
                    />

                    <input
                      type="time"
                      value={form.dueTime}
                      onChange={(event) =>
                        setForm({ ...form, dueTime: event.target.value })
                      }
                    />
                  </div>

                  <button className="primary" type="submit">
                    Add Task
                  </button>
                </form>
              </div>

              <div className="prompt-panel">
                <h2>AI task steps</h2>

                <textarea
                  placeholder="Describe the result you want..."
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                />

                <button className="secondary" type="button" onClick={generateSteps}>
                  Generate Steps
                </button>

                {newSteps.length > 0 && (
                  <>
                    <ol className="step-preview">
                      {newSteps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>

                    <button
                      className="primary"
                      type="button"
                      disabled={!activeTask}
                      onClick={addStepsToTask}
                    >
                      Add Steps to Current Task
                    </button>
                  </>
                )}
              </div>
            </section>

            <section className="card">
              {!activeTask ? (
                <div className="empty">
                  <div>
                    <h2>No tasks yet</h2>
                    <p>Create your first task to begin.</p>
                  </div>
                </div>
              ) : (
                <article
                  className="task-card"
                  style={{ "--priority": priorityStyles[activeTask.priority] }}
                >
                  <div className="task-header">
                    <div>
                      <h3>{activeTask.title}</h3>
                      <span className="badge">{activeTask.category}</span>
                      <span className="muted" style={{ marginLeft: 8 }}>
                        {activeTask.priority}
                      </span>
                    </div>

                    <strong>{getProgress(activeTask)}%</strong>
                  </div>

                  <p className="description">
                    {activeTask.description || "No notes added to this task."}
                  </p>

                  <div>
                    <div className="progress-track">
                      <div
                        className="progress-fill"
                        style={{ width: `${getProgress(activeTask)}%` }}
                      />
                    </div>

                    <div className="row" style={{ marginTop: 9 }}>
                      <span className="muted">Manual</span>
                      <input
                        className="range"
                        type="range"
                        min="0"
                        max="100"
                        value={activeTask.manualProgress}
                        onChange={(event) =>
                          updateTask(activeTask.id, {
                            manualProgress: Number(event.target.value),
                          })
                        }
                      />
                      <span className="muted">
                        {activeTask.manualProgress}%
                      </span>
                    </div>
                  </div>

                  <div className="steps">
                    {activeTask.steps.length ? (
                      activeTask.steps.map((step) => (
                        <label
                          key={step.id}
                          className={`step ${step.completed ? "done" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={step.completed}
                            onChange={() => toggleStep(activeTask.id, step.id)}
                          />
                          {step.text}
                        </label>
                      ))
                    ) : (
                      <span className="muted">
                        Generate checklist steps from the left panel.
                      </span>
                    )}
                  </div>

                  <footer className="task-footer">
                    <span className={isOverdue(activeTask) ? "overdue" : "muted"}>
                      Due {activeTask.dueDate} · {activeTask.dueTime}
                      {isOverdue(activeTask) ? " · Overdue" : ""}
                    </span>

                    <div className="pager">
                      <button
                        type="button"
                        disabled={activeTaskIndex === 0}
                        onClick={() => setActiveTaskIndex((index) => index - 1)}
                      >
                        ←
                      </button>

                      <span className="muted">
                        {activeTaskIndex + 1}/{tasks.length}
                      </span>

                      <button
                        type="button"
                        disabled={activeTaskIndex === tasks.length - 1}
                        onClick={() => setActiveTaskIndex((index) => index + 1)}
                      >
                        →
                      </button>

                      <button
                        type="button"
                        className="danger"
                        onClick={() => deleteTask(activeTask.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </footer>
                </article>
              )}
            </section>

            <aside className="card insights">
              <div className="metrics">
                <div className="metric">
                  <span className="muted">Tasks</span>
                  <strong>{tasks.length}</strong>
                  <span className="muted">total</span>
                </div>

                <div className="metric">
                  <span className="muted">Completed</span>
                  <strong>{metrics.completed}</strong>
                  <span className="muted">tasks</span>
                </div>

                <div className="metric">
                  <span className="muted">Steps</span>
                  <strong>
                    {metrics.completedSteps}/{metrics.totalSteps}
                  </strong>
                  <span className="muted">done</span>
                </div>

                <div className="metric">
                  <span className="muted">Overdue</span>
                  <strong>{metrics.overdue}</strong>
                  <span className="muted">tasks</span>
                </div>
              </div>

              <div className="chart">
                <div className="chart-wrap">
                  <svg width="170" height="170" viewBox="0 0 130 130">
                    <defs>
                      <linearGradient id="chart-gradient" x1="0%" x2="100%">
                        <stop stopColor="#2563eb" />
                        <stop offset="1" stopColor="#7c3aed" />
                      </linearGradient>
                    </defs>

                    <circle
                      cx="65"
                      cy="65"
                      r="54"
                      fill="none"
                      stroke="#e2e8f0"
                      strokeWidth="11"
                    />

                    <circle
                      className="chart-ring"
                      cx="65"
                      cy="65"
                      r="54"
                      fill="none"
                      stroke="url(#chart-gradient)"
                      strokeWidth="11"
                      strokeLinecap="round"
                      strokeDasharray={339.29}
                      strokeDashoffset={339.29 - (metrics.progress / 100) * 339.29}
                    />
                  </svg>

                  <div className="chart-label">
                    <strong>{metrics.progress}%</strong>
                    <span className="muted">progress</span>
                  </div>
                </div>
              </div>
            </aside>
          </main>
        ) : (
          <main className="page spotify-page">
            <section className="card">
              {!spotifyToken ? (
                <div className="empty">
                  <div>
                    <h2>Connect Spotify</h2>
                    <p>Sign in to access your playlists here.</p>

                    <button
                      type="button"
                      className="secondary"
                      onClick={loginSpotify}
                      disabled={spotifyLoading}
                    >
                      {spotifyLoading ? "Connecting..." : "Sign In With Spotify"}
                    </button>

                    {spotifyMessage && (
                      <p className="muted" style={{ marginTop: 12 }}>
                        {spotifyMessage}
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  {spotifyLoading && (
                    <p className="muted" role="status">
                      Loading your Spotify account...
                    </p>
                  )}

                  {spotifyMessage && !spotifyLoading && (
                    <div className="spotify-error" role="alert">
                      <span>{spotifyMessage}</span>
                      <button
                        type="button"
                        className="tab"
                        onClick={() => setSpotifyRetry((count) => count + 1)}
                      >
                        Try again
                      </button>
                    </div>
                  )}

                  <div className="spotify-profile">
                    {spotifyUser?.images?.[0]?.url ? (
                      <img
                        className="avatar"
                        src={spotifyUser.images[0].url}
                        alt=""
                      />
                    ) : (
                      <div className="avatar" />
                    )}

                    <div>
                      <strong>{spotifyUser?.display_name || "Spotify User"}</strong>
                      <div className="muted">Connected</div>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="danger"
                    style={{ marginTop: 14 }}
                    onClick={logoutSpotify}
                  >
                    Disconnect
                  </button>

                  <form className="spotify-search" onSubmit={searchSpotify}>
                    <div className="search-row">
                      <input
                        type="search"
                        value={spotifySearchQuery}
                        placeholder="Search songs or artists"
                        aria-label="Search Spotify songs or artists"
                        onChange={(event) => {
                          setSpotifySearchQuery(event.target.value);
                          setSpotifySearchSubmitted(false);
                        }}
                      />
                      <button
                        type="submit"
                        className="primary"
                        disabled={spotifySearchLoading || !spotifySearchQuery.trim()}
                      >
                        {spotifySearchLoading ? "Searching..." : "Search"}
                      </button>
                    </div>

                    {spotifySearchMessage && (
                      <p className="spotify-search-message" role="alert">
                        {spotifySearchMessage}
                      </p>
                    )}

                    {!spotifySearchLoading &&
                      spotifySearchSubmitted &&
                      spotifySearchQuery.trim() &&
                      !spotifySearchMessage &&
                      spotifySearchResults.length === 0 && (
                        <p className="muted">No songs found.</p>
                      )}

                    {spotifySearchResults.length > 0 && (
                      <div className="track-list">
                        {spotifySearchResults.map((track) => (
                          <div
                            className={`track ${
                              selectedTrack?.id === track.id ? "selected" : ""
                            }`}
                            key={track.id}
                          >
                            {track.album?.images?.[2]?.url ||
                            track.album?.images?.[0]?.url ? (
                              <img
                                className="track-cover"
                                src={
                                  track.album.images[2]?.url ||
                                  track.album.images[0].url
                                }
                                alt=""
                              />
                            ) : (
                              <div className="track-cover" />
                            )}

                            <div className="track-info">
                              <div className="playlist-name">{track.name}</div>
                              <div className="muted">
                                {track.artists?.map((artist) => artist.name).join(", ")}
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={() => {
                                setSelectedTrack(track);
                                setSelectedPlaylist(null);
                              }}
                            >
                              Play
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </form>

                  <h2 style={{ marginTop: 18 }}>Your Playlists</h2>

                  <div className="playlist-list">
                    {playlists.map((playlist) => (
                      <div
                        key={playlist.id}
                        className={`playlist ${
                          selectedPlaylist?.id === playlist.id ? "selected" : ""
                        }`}
                      >
                        {playlist.images?.[0]?.url ? (
                          <img
                            className="playlist-cover"
                            src={playlist.images[0].url}
                            alt=""
                          />
                        ) : (
                          <div className="playlist-cover" />
                        )}

                        <div className="playlist-info">
                          <div className="playlist-name">{playlist.name}</div>
                          <div className="muted">
                            {playlist.tracks?.total ?? 0} tracks
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => {
                            setSelectedPlaylist(playlist);
                            setSelectedTrack(null);
                          }}
                        >
                          Play
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>

            <section className="card">
              {selectedTrack || selectedPlaylist ? (
                <>
                  <h2>{selectedTrack?.name || selectedPlaylist?.name}</h2>

                  {selectedTrack && (
                    <button
                      type="button"
                      className="primary"
                      onClick={playSelectedTrack}
                    >
                      Play selected song
                    </button>
                  )}

                  <SpotifyEmbed
                    uri={`spotify:${selectedTrack ? "track" : "playlist"}:${
                      selectedTrack?.id || selectedPlaylist?.id
                    }`}
                    theme={theme}
                    onTrackEnded={handleTrackEnded}
                    controllerRef={spotifyControllerRef}
                  />

                  <p className="muted" style={{ marginTop: 10 }}>
                    You can use playback controls directly in this Spotify player.
                  </p>
                </>
              ) : (
                <div className="empty">
                  <div>
                    <h2>Your Spotify player will appear here</h2>
                    <p>Sign in and choose a playlist.</p>
                  </div>
                </div>
              )}
            </section>
          </main>
        )}
      </div>
    </div>
  );
}