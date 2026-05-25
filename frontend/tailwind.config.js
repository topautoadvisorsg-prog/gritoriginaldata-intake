/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: '#0c0c0e',
        surface: '#141418',
        border: '#252530',
        accent: '#e8192c',
        green: '#10b981',
        gold: '#f5a623',
        text: '#e2e0dc',
        muted: '#6b6a72',
      },
    },
  },
  plugins: [],
}
