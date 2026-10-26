module.exports = {
  plugins: [
    require('postcss-import'),
    // `is-pseudo-class` polyfills `:is()`, which every target browser already supports
    // natively; left enabled, it fails on Tailwind's `:is(.dark *)` dark-mode selectors
    // and its "can not be transformed" warnings carry no real source position, which
    // triggers an infinite loop in Vite's code-frame renderer (generateCodeFrame) and
    // hangs the build indefinitely.
    require('postcss-preset-env')({ features: { 'is-pseudo-class': false } }),
    require('tailwindcss'),
    require('autoprefixer'),
  ],
};
