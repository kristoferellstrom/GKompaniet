import { useEffect, useMemo, useState } from "react";

const apiBase = import.meta.env.VITE_API_BASE || "http://localhost:8000";
const endpoints = {
  status: `${apiBase}/api/status`,
  enter: `${apiBase}/api/enter-code`,
  contact: `${apiBase}/api/submit-contact`,
};

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
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
  return value.replace(/\D/g, "").slice(0, 3);
}

export default function App() {
  const initialClaimToken = useMemo(() => sessionStorage.getItem("claimToken") || "", []);

  const [view, setView] = useState(initialClaimToken ? "contact" : "code");
  const [code, setCode] = useState("");
  const [codeStatus, setCodeStatus] = useState({ message: "", type: "" });
  const [blockedUntil, setBlockedUntil] = useState(null);
  const [timerText, setTimerText] = useState("");
  const [searchVariant, setSearchVariant] = useState("search");
  const [claimToken, setClaimToken] = useState(initialClaimToken);
  const [contactStatus, setContactStatus] = useState({ message: "", type: "" });
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");

  const isWinnerView = view === "contact" || view === "success";
  const isBlocked = blockedUntil && blockedUntil > Date.now();
  const canSubmitCode = code.length === 3 && !isBlocked;

  useEffect(() => {
    let active = true;

    const loadStatus = async () => {
      setCodeStatus({ message: "Kontrollerar status...", type: "" });
      try {
        const { response, data } = await fetchJSON(endpoints.status);
        if (!active) return;

        if (claimToken) {
          setView("contact");
          setCodeStatus({ message: "", type: "" });
          return;
        }

        if (!response.ok || !data) {
          throw new Error("status-failed");
        }

        if (data.closed) {
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

    if (sanitized.length !== 3 || isBlocked) {
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
        break;
      case "blocked": {
        setCodeStatus({ message: "För många fel. Du är spärrad en stund.", type: "error" });
        setSearchVariant("lost");
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
      return;
    }

    if (data?.reason === "unauthorized") {
      sessionStorage.removeItem("claimToken");
      setClaimToken("");
      setView("closed");
      return;
    }

    setContactStatus({ message: "Kunde inte skicka. Försök igen.", type: "error" });
  };

  return (
    <>
      <div className="ambient" />
      <main className="page">
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
              <p className="side-emphasis">Felvänt</p>
            </>
          )}
        </div>
        <section className="panel" aria-live="polite">
          <div className={`view ${view === "code" ? "is-active" : ""}`} data-view="code">
            <h2>Skriv in koden:</h2>
            <form onSubmit={handleCodeSubmit}>
              <label className="field">
                <input
                  id="code-input"
                  type="text"
                  inputMode="numeric"
                  pattern="\d{3}"
                  maxLength={3}
                  autoComplete="one-time-code"
                  placeholder="___"
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
            <p className="muted">V kontaktar dig snarast.</p>
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
            <div className="won-slot" aria-hidden="true" />
          </div>

          <div className={`view ${view === "closed" ? "is-active" : ""}`} data-view="closed">
            <h2>Någon hann före</h2>
            <p className="muted">Priset är redan taget. Bättre lycka nästa gång!</p>
            <div className="stamp">CLOSED</div>
          </div>

          <div className={`view ${view === "success" ? "is-active" : ""}`} data-view="success">
            <h2>Tack! Vi hör av oss.</h2>
            <p className="muted">Din information är mottagen. Ha en fin dag!</p>
            <div className="confetti" aria-hidden="true" />
          </div>
        </section>
      </main>
    </>
  );
}
