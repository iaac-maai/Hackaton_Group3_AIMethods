// Small inline SVG icons. Stroke uses currentColor so they follow the surrounding text colour.

type P = { className?: string; size?: number };
const base = (size = 20) => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true,
});

export const IconVideoUpload = ({ className, size = 40 }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="2.5" y="5" width="13.5" height="14" rx="3" />
    <path d="M16 10.2l4.6-2.6a.6.6 0 0 1 .9.5v7.8a.6.6 0 0 1-.9.5L16 13.8" />
    <path d="M9.25 15V9M6.75 11.5l2.5-2.5 2.5 2.5" />
  </svg>
);

export const IconSliders = ({ className, size = 18 }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
    <circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" />
  </svg>
);

export const IconChevron = ({ className, size = 16 }: P) => (
  <svg {...base(size)} className={className}><path d="M6 9l6 6 6-6" /></svg>
);

export const IconUsers = ({ className, size = 15 }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="9" cy="8" r="3.2" /><path d="M3 19.5c.6-3.3 3-5 6-5s5.4 1.7 6 5" />
    <path d="M15.5 5.2a3 3 0 0 1 0 5.6M18 14.8c1.6.7 2.7 2.2 3 4.7" />
  </svg>
);

export const IconTag = ({ className, size = 15 }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1 1 0 0 1 0 1.4l-7.1 7.1a1 1 0 0 1-1.4 0z" /><circle cx="8" cy="8" r="1.4" />
  </svg>
);

export const IconFrame = ({ className, size = 15 }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
  </svg>
);

export const IconCpu = ({ className, size = 15 }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="6" y="6" width="12" height="12" rx="2" /><path d="M10 10h4v4h-4zM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
  </svg>
);

export const IconClock = ({ className, size = 15 }: P) => (
  <svg {...base(size)} className={className}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
);

export const IconCheckShield = ({ className, size = 15 }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3l7 3v5.5c0 4.4-3 7.8-7 9.5-4-1.7-7-5.1-7-9.5V6z" /><path d="M8.8 12.2l2.2 2.2 4.2-4.4" />
  </svg>
);

export const IconAlert = ({ className, size = 20 }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M12 3.5l9 16H3z" /><path d="M12 10v4.5M12 17.4v.1" />
  </svg>
);

export const IconEye = ({ className, size = 15 }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" />
  </svg>
);

export const IconList = ({ className, size = 18 }: P) => (
  <svg {...base(size)} className={className}><path d="M9 6.5h11M9 12h11M9 17.5h11" /><circle cx="4.5" cy="6.5" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="17.5" r="1" /></svg>
);

export const IconCoffee = ({ className, size = 18 }: P) => (
  <svg {...base(size)} className={className}><path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z" /><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5v2.5M12 3.5v2.5" /></svg>
);

export const IconMeal = ({ className, size = 18 }: P) => (
  <svg {...base(size)} className={className}><path d="M6 3v7a2 2 0 0 0 4 0V3M8 10v11M17 21V3c-2 1.5-3 4-3 7h3" /></svg>
);

export const IconRepeat = ({ className, size = 18 }: P) => (
  <svg {...base(size)} className={className}><path d="M4 11V9a3 3 0 0 1 3-3h12l-3-3M20 13v2a3 3 0 0 1-3 3H5l3 3" /></svg>
);

export const IconScale = ({ className, size = 18 }: P) => (
  <svg {...base(size)} className={className}><path d="M12 4v16M7 20h10M5 7h14M5 7l-3 6a3 3 0 0 0 6 0zM19 7l-3 6a3 3 0 0 0 6 0z" /></svg>
);

export const IconFlame = ({ className, size = 15 }: P) => (
  <svg {...base(size)} className={className}><path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.6 3-5.4 3.6-9.3 2 1.4 3.2 3.3 3.4 5.4.9-.6 1.5-1.6 1.7-2.8 2 1.6 4.3 4 4.3 6.9C18.5 18.4 15.9 21 12 21z" /></svg>
);

export const IconCopy = ({ className, size = 16 }: P) => (
  <svg {...base(size)} className={className}><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></svg>
);

export const IconDownload = ({ className, size = 16 }: P) => (
  <svg {...base(size)} className={className}><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14" /></svg>
);

export const IconTrash = ({ className, size = 16 }: P) => (
  <svg {...base(size)} className={className}><path d="M4.5 7h15M10 7V4.5h4V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5" /></svg>
);

export const IconFilm = ({ className, size = 15 }: P) => (
  <svg {...base(size)} className={className}><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M8 5v14M16 5v14M3.5 9.5H8M3.5 14.5H8M16 9.5h4.5M16 14.5h4.5" /></svg>
);

export const IconStar = ({ className, size = 18 }: P) => (
  <svg {...base(size)} className={className}><path d="M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z" /></svg>
);

export const IconArrowRight = ({ className, size = 16 }: P) => (
  <svg {...base(size)} className={className}><path d="M5 12h14M13.5 6.5L19 12l-5.5 5.5" /></svg>
);

export const IconCheck = ({ className, size = 16 }: P) => (
  <svg {...base(size)} className={className}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);

export const IconX = ({ className, size = 16 }: P) => (
  <svg {...base(size)} className={className}><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></svg>
);

export const IconCalendar = ({ className, size = 18 }: P) => (
  <svg {...base(size)} className={className}><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>
);

export const IconInfo = ({ className, size = 18 }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.6v.1" />
  </svg>
);
