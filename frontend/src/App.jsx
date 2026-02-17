import { useEffect, useMemo, useRef, useState } from "react";

const apiBase = import.meta.env.VITE_API_BASE || "http://localhost:8000";
const assetBase = import.meta.env.BASE_URL || "/";
const assetUrl = (path) => `${assetBase}${path.replace(/^\/+/, "")}`;
const DEVICE_STORAGE_KEY = "gk_device_id";
const endpoints = {
  status: `${apiBase}/api/status`,
  enter: `${apiBase}/api/enter-code`,
  contact: `${apiBase}/api/submit-contact`,
};

function generateDeviceId() {
  if (typeof crypto !== "undefined") {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replace(/-/g, "");
    }
    if (typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 18)}`;
}

function getStableDeviceId() {
  if (typeof window === "undefined") {
    return "";
  }

  try {
    const existing = window.localStorage.getItem(DEVICE_STORAGE_KEY) || "";
    if (/^[A-Za-z0-9_-]{16,128}$/.test(existing)) {
      return existing;
    }
    const next = generateDeviceId();
    window.localStorage.setItem(DEVICE_STORAGE_KEY, next);
    return next;
  } catch {
    return "";
  }
}

async function fetchJSON(url, options = {}) {
  const deviceId = getStableDeviceId();
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (deviceId) {
    headers["X-Device-Id"] = deviceId;
  }

  const response = await fetch(url, {
    headers,
    credentials: "include",
    ...options,
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return { response, data };
}

function sanitizeCode(value) {
  return value.replace(/[^0-9A-Za-z]/g, "").slice(0, 4);
}

export default function App() {
  const initialClaimToken = useMemo(() => sessionStorage.getItem("claimToken") || "", []);
  const initialWinnerSubmitted = useMemo(
    () => sessionStorage.getItem("winnerSubmitted") === "true",
    [],
  );

  const [view, setView] = useState(initialClaimToken ? "contact" : "code");
  const [code, setCode] = useState("");
  const [codeStatus, setCodeStatus] = useState({ message: "", type: "" });
  const [blockedUntil, setBlockedUntil] = useState(null);
  const [timerText, setTimerText] = useState("");
  const [searchVariant, setSearchVariant] = useState("search");
  const [winnerSubmitted, setWinnerSubmitted] = useState(initialWinnerSubmitted);
  const [winImageVariant, setWinImageVariant] = useState("won");
  const [fireworksActive, setFireworksActive] = useState(false);
  const [claimToken, setClaimToken] = useState(initialClaimToken);
  const [contactStatus, setContactStatus] = useState({ message: "", type: "" });
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const winAudioRef = useRef(null);
  const failAudioRef = useRef(null);
  const winImageTimerRef = useRef(null);
  const fireworksTimerRef = useRef(null);

  const isWinnerView = view === "contact" || view === "success";
  const isBlocked = blockedUntil && blockedUntil > Date.now();
  const canSubmitCode = code.length === 4 && !isBlocked;

  useEffect(() => {
    if (!isWinnerView) {
      setFireworksActive(false);
      setWinImageVariant("won");
      if (winImageTimerRef.current) {
        clearTimeout(winImageTimerRef.current);
        winImageTimerRef.current = null;
      }
      if (fireworksTimerRef.current) {
        clearTimeout(fireworksTimerRef.current);
        fireworksTimerRef.current = null;
      }
    }
  }, [isWinnerView]);

  useEffect(() => {
    document.body.classList.toggle("closed-mobile-cover", view === "closed");
    return () => {
      document.body.classList.remove("closed-mobile-cover");
    };
  }, [view]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--bg-image", `url("${assetUrl("images/gymkompaniet_back.webp")}")`);
    root.style.setProperty("--search-image", `url("${assetUrl("images/Search.webp")}")`);
    root.style.setProperty("--lost-image", `url("${assetUrl("images/Lost.webp")}")`);
    root.style.setProperty("--won-image", `url("${assetUrl("images/Won.webp")}")`);
    root.style.setProperty("--sunglasses-image", `url("${assetUrl("images/sunglasses.png")}")`);
  }, []);

  useEffect(() => {
    return () => {
      if (winImageTimerRef.current) {
        clearTimeout(winImageTimerRef.current);
      }
      if (fireworksTimerRef.current) {
        clearTimeout(fireworksTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let active = true;

    const loadStatus = async () => {
      setCodeStatus({ message: "Kontrollerar status...", type: "" });
      try {
        const { response, data } = await fetchJSON(endpoints.status);
        if (!active) return;

        if (response.ok && data && data.closed === false) {
          sessionStorage.removeItem("winnerSubmitted");
          setWinnerSubmitted(false);
        }

        if (claimToken) {
          setView("contact");
          setCodeStatus({ message: "", type: "" });
          return;
        }

        if (!response.ok || !data) {
          throw new Error("status-failed");
        }

        if (data.closed) {
          if (winnerSubmitted) {
            setView("success");
            return;
          }
          setView("closed");
        } else {
          setView("code");
        }

        setCodeStatus({ message: "", type: "" });
      } catch {
        if (!active) return;
        setView("code");
        setCodeStatus({ message: "Kunde inte nå servern. Kontrollera att backend kör.", type: "error" });
      }
    };

    loadStatus();

    return () => {
      active = false;
    };
  }, [claimToken]);

  useEffect(() => {
    if (!blockedUntil) {
      setTimerText("");
      return;
    }

    const tick = () => {
      const diffMs = blockedUntil - Date.now();
      if (diffMs <= 0) {
        setBlockedUntil(null);
        setTimerText("Du kan försöka igen.");
        return;
      }
      const totalSeconds = Math.ceil(diffMs / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      setTimerText(`Försök igen om ${minutes}:${String(seconds).padStart(2, "0")}`);
    };

    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [blockedUntil]);

  const handleCodeChange = (event) => {
    const value = sanitizeCode(event.target.value);
    setCode(value);
    setSearchVariant("search");
  };

  const handleCodeSubmit = async (event) => {
    event.preventDefault();
    const sanitized = sanitizeCode(code);
    setCode(sanitized);

    if (sanitized.length !== 4 || isBlocked) {
      return;
    }

    setCodeStatus({ message: "Kontrollerar kod...", type: "" });
    setTimerText("");

    const { response, data } = await fetchJSON(endpoints.enter, {
      method: "POST",
      body: JSON.stringify({ code: sanitized }),
    });

    if (response.ok && data?.ok) {
      setSearchVariant("won");
      setWinImageVariant("won");
      setFireworksActive(true);
      if (winImageTimerRef.current) {
        clearTimeout(winImageTimerRef.current);
      }
      if (fireworksTimerRef.current) {
        clearTimeout(fireworksTimerRef.current);
      }
      winImageTimerRef.current = window.setTimeout(() => {
        setWinImageVariant("sunglasses");
      }, 9700);
      fireworksTimerRef.current = window.setTimeout(() => {
        setFireworksActive(false);
      }, 23000);
      if (winAudioRef.current) {
        winAudioRef.current.currentTime = 0;
        winAudioRef.current.play().catch(() => {});
      }
      setClaimToken(data.claimToken);
      sessionStorage.setItem("claimToken", data.claimToken);
      setView("contact");
      setContactStatus({ message: "", type: "" });
      return;
    }

    if (!data) {
      setCodeStatus({ message: "Något gick fel. Försök igen.", type: "error" });
      return;
    }

    switch (data.reason) {
      case "already_won":
        setView("closed");
        break;
      case "wrong_code":
        setCodeStatus({ message: `Fel kod. Försök kvar: ${data.remaining}`, type: "error" });
        setSearchVariant("lost");
        if (failAudioRef.current) {
          failAudioRef.current.currentTime = 0;
          failAudioRef.current.play().catch(() => {});
        }
        break;
      case "blocked": {
        setCodeStatus({ message: "För många fel. Du är spärrad en stund.", type: "error" });
        setSearchVariant("lost");
        if (failAudioRef.current) {
          failAudioRef.current.currentTime = 0;
          failAudioRef.current.play().catch(() => {});
        }
        const until = Date.parse(data.blockedUntil);
        if (!Number.isNaN(until)) {
          setBlockedUntil(until);
        }
        break;
      }
      case "invalid_format":
        setCodeStatus({ message: "Ange exakt tre siffror.", type: "error" });
        break;
      default:
        setCodeStatus({ message: "Något gick fel. Försök igen.", type: "error" });
    }
  };

  const handleContactSubmit = async (event) => {
    event.preventDefault();

    if (!claimToken) {
      setView("closed");
      return;
    }

    setContactStatus({ message: "Skickar...", type: "" });

    const { response, data } = await fetchJSON(endpoints.contact, {
      method: "POST",
      body: JSON.stringify({
        claimToken,
        name: contactName.trim(),
        email: contactEmail.trim(),
        phone: contactPhone.trim() || null,
      }),
    });

    if (response.ok && data?.ok) {
      setView("success");
      setWinnerSubmitted(true);
      sessionStorage.setItem("winnerSubmitted", "true");
      sessionStorage.removeItem("claimToken");
      setClaimToken("");
      return;
    }

    if (data?.reason === "unauthorized") {
      sessionStorage.removeItem("claimToken");
      setClaimToken("");
      if (winnerSubmitted) {
        setView("success");
      } else {
        setView("closed");
      }
      return;
    }

    setContactStatus({ message: "Kunde inte skicka. Försök igen.", type: "error" });
  };

  return (
    <>
      <div className="ambient" />
      {isWinnerView && fireworksActive ? (
        <div className="fireworks" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : null}
      <audio ref={winAudioRef} src={assetUrl("audio/won.mp3")} preload="auto" />
      <audio ref={failAudioRef} src={assetUrl("audio/fail.mp3")} preload="auto" />
      <main className="page">
        {view !== "closed" ? (
          <div className="side-word">
            {isWinnerView ? (
              <>
                <p className="side-win-title">BOOM! VINST!</p>
                <p className="side-win-sub">Grattis till 30 000 kr i gymutrustning!</p>
                <blockquote className="side-quote">
                  <p>
                    &quot;Av alla som stod vid startlinjen var det du som tog dig hela vägen. En ensam
                    segrare. En tydlig etta. Grattis — vinsten är din.&quot;
                  </p>
                  <footer>— Joel Lövernberg, Gymkompaniet Ab</footer>
                </blockquote>
              </>
            ) : (
              <>
                <p className="side-body">Wow! Att du har hittat hit betyder att du är nära.</p>
                <p className="side-body">Sitt lugnt i båten.</p>
                <p className="side-body">Du har tre försök att skriva in rätt kod – sedan är det stopp.</p>
                <p className="side-body">Det finns bara en vinnare. Kommer det bli du?</p>
                <p className="side-final">En sista ledtråd:</p>
                <p className="side-emphasis">Spegelvänt</p>
              </>
            )}
          </div>
        ) : null}
        <section className="panel" aria-live="polite">
          <div className={`view ${view === "code" ? "is-active" : ""}`} data-view="code">
            <h2>Skriv in koden:</h2>
            <form onSubmit={handleCodeSubmit}>
              <label className="field">
                <input
                  id="code-input"
                  type="text"
                  inputMode="text"
                  pattern="[0-9A-Z]{4}"
                  maxLength={4}
                  autoComplete="one-time-code"
                  placeholder="____"
                  value={code}
                  onChange={handleCodeChange}
                />
              </label>
              <button type="submit" disabled={!canSubmitCode}>
                Testa koden
              </button>
            </form>
            <div className={`status ${codeStatus.type}`}>{codeStatus.message}</div>
            <div className="timer" aria-live="polite">
              {timerText}
            </div>
            <div
              className={`search-slot ${searchVariant === "lost" ? "is-lost" : ""} ${
                searchVariant === "won" ? "is-won" : ""
              }`}
              aria-hidden="true"
            />
          </div>

          <div className={`view ${view === "contact" ? "is-active" : ""}`} data-view="contact">
            <h2>Lämna dina uppgifter</h2>
            <p className="muted win-subtext">V kontaktar dig snarast.</p>
            <form onSubmit={handleContactSubmit}>
              <label className="field">
                <span>Namn</span>
                <input
                  type="text"
                  required
                  placeholder="För- och efternamn"
                  value={contactName}
                  onChange={(event) => setContactName(event.target.value)}
                />
              </label>
              <label className="field">
                <span>E-post</span>
                <input
                  type="email"
                  required
                  placeholder="namn@example.com"
                  value={contactEmail}
                  onChange={(event) => setContactEmail(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Telefon (valfritt)</span>
                <input
                  type="tel"
                  placeholder="07X-XXX XX XX"
                  value={contactPhone}
                  onChange={(event) => setContactPhone(event.target.value)}
                />
              </label>
              <button type="submit">Skicka</button>
            </form>
            <div className={`status ${contactStatus.type}`}>{contactStatus.message}</div>
            <div className={`won-slot ${winImageVariant === "sunglasses" ? "is-sunglasses" : ""}`} aria-hidden="true" />
          </div>

          <div className={`view ${view === "closed" ? "is-active" : ""}`} data-view="closed">
            <h2>Attans någon hann före...</h2>
            <p className="muted">Tävlingen är avgjord priset är redan taget</p>
            <blockquote className="side-quote">
              <p>
                Tystnaden efter mållinjen säger allt:
                <br />
                Någon var först.
                <br />
                Men dina steg hit räknas också.
                <br />
                Den som vågar förlora
                <br />
                har redan börjat lära sig att vinna.
                <br />
                Men glöm inte: i dag förlorade DU!
                <br />
                <br />
                Vi ses i nästa omgång.
              </p>
              <footer>— Joel Löwenberg, Gymkompaniet AB</footer>
            </blockquote>
          </div>

          <div className={`view ${view === "success" ? "is-active" : ""}`} data-view="success">
            <h2>Tack! Vi hör av oss.</h2>
            <a className="logo-link" href="https://gymkompaniet.se" target="_blank" rel="noreferrer">
              <img className="logo-image" src={assetUrl("images/gymkompaniet_1.webp")} alt="Gymkompaniet" />
            </a>
          </div>
        </section>
      </main>
      <footer className="page-footer" aria-hidden="true">
        <div className="sound-note">{view === "code" ? "Ljud: På" : ""}</div>
        <div className="copyright">© Gymkompaniet AB</div>
        <div />
      </footer>
    </>
  );
}
