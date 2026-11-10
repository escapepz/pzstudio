// tailwind-brand.config.js — PZ Studio Monochromatic Developer Theme
module.exports = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        pz: {
          black: '#090A0B',
          surface: '#121416',
          elevated: '#202327',
          border: '#353A40',
          secondary: '#AEB4BB',
          white: '#F8F8F6',
        },
      },
      fontFamily: {
        display: ['Space Grotesk', 'Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'Geist Mono', 'monospace'],
      },
    },
  },
};