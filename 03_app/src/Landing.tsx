import logo from "./assets/motion-atlas-logo-compact.png";

// Landing page shown before login: logo, tagline and a login button only (RedSun-style hero).

// Visitors who ask for reduced motion see the poster only; the video is never played.
const reduceMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export function Landing({ onLogin }: { onLogin: () => void }) {
  const still = reduceMotion();
  return (
    <main className="landing">
      {/* Decorative background video: muted, looping, no controls, hidden from assistive tech */}
      <video className="landing-video" poster="/landing_bg_poster.jpg" src={still ? undefined : "/landing_bg.mp4"}
        autoPlay={!still} muted loop playsInline preload={still ? "none" : "auto"} disablePictureInPicture
        aria-hidden="true" tabIndex={-1} ref={(v) => { if (v) v.muted = true; }} />
      <div className="landing-video-overlay" aria-hidden="true" />
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
