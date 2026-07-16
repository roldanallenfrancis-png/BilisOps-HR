/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Light green brand scale (primary accent + CTAs)
        brand: {
          50:  '#f0fcf2',
          100: '#dcf7e1',
          200: '#bcedc6',
          300: '#8fe0a0',
          400: '#6ed37f',
          500: '#5ac56b', // primary — light green
          600: '#48b95a', // hover / active
          700: '#3a9c49',
          800: '#2f7a3a',
          900: '#286231',
        },
        // Nexcent neutrals
        ink:  '#18191f', // headings
        body: '#717171', // body copy
        mist: '#f5f7fa', // light section background
      },
      boxShadow: {
        brand: '0 10px 25px -5px rgba(90,197,107,0.38)',
      },
    },
  },
  plugins: [],
}
