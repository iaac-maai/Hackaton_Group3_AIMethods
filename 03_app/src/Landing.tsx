import logo from "./assets/motion-atlas-logo-compact.png";

// Landing page shown before login: logo, tagline and a login button only (RedSun-style hero).

export function Landing({ onLogin }: { onLogin: () => void }) {
  return (
    <main className="landing">
      <div className="landing-beams" aria-hidden="true" />
      <section className="landing-hero">
        <h1 className="landing-logo">
          <img src={logo} alt="Motion Atlas" width={1281} height={303} />
        </h1>
        <p className="landing-tagline">Movement review for construction</p>
        <button type="button" className="button landing-cta" onClick={onLogin}>
          Log in <span aria-hidden="true">→</span>
        </button>
      </section>
      <div className="landing-arc" aria-hidden="true" />
    </main>
  );
}
