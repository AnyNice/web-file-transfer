/** @type {import('tailwindcss').Config} */
// 主题与旧版 layout 里内联的 CDN tailwind.config 保持一致
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        pageBg: "#faf9f9",
        errorRed: "#d92525",
        errorRedLight: "#fde8e8",
        brandGreen: "#28a745",
        brandGreenLight: "#eafceb",
      },
      boxShadow: {
        softFloat: "0 14px 44px rgba(0,0,0,0.055)",
      },
      borderRadius: {
        shell: "22px",
        tab: "14px 14px 4px 4px",
        codeCard: "14px",
      },
    },
  },
  plugins: [],
};
