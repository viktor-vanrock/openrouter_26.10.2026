module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['babel-jest', { configFile: require.resolve('../data-schemas/babel.config.cjs') }],
  },
  moduleFileExtensions: ['ts', 'js'],
};
