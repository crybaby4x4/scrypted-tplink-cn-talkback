const path = require('path');

module.exports = {
  context: __dirname,
  entry: './src/main.ts',
  target: 'node',
  mode: 'development',
  devtool: 'inline-source-map',
  module: {
    rules: [{
      test: /\.tsx?$/,
      use: 'ts-loader',
      exclude: /node_modules/,
    }],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  output: {
    filename: 'main.nodejs',
    path: path.resolve(__dirname, 'dist'),
    libraryTarget: 'commonjs2',
  },
  externals: {
    '@scrypted/sdk': 'commonjs @scrypted/sdk',
  },
};
