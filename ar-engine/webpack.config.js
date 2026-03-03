const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
    mode: 'development',
    entry: './src/js/main.js',
    output: {
        filename: 'bundle.js',
        path: path.resolve(__dirname, 'dist'),
        clean: true,
        publicPath: '/'
    },
    devtool: 'source-map',
    devServer: {
        static: {
            directory: path.join(__dirname, 'public')
        },
        port: 8080,
        hot: true,
        open: true,
        allowedHosts: 'all'
    },
    plugins: [
        new HtmlWebpackPlugin({
            template: './public/index.html'
        }),
        new CopyWebpackPlugin({
            patterns: [
                {
                    from: 'public/wasm/ar-engine.js',
                    to: 'wasm/ar-engine.js',
                    noErrorOnMissing: true
                },
                {
                    from: 'public/wasm/ar-engine.wasm',
                    to: 'wasm/ar-engine.wasm',
                    noErrorOnMissing: true
                },
                {
                    from: 'public/wasm/ar-math.js',
                    to: 'wasm/ar-math.js',
                    noErrorOnMissing: true
                },
                {
                    from: 'public/wasm/ar-math.wasm',
                    to: 'wasm/ar-math.wasm',
                    noErrorOnMissing: true
                },
                {
                    from: 'public/test-math.html',
                    to: 'test-math.html',
                    noErrorOnMissing: true
                },
                {
                    from: 'public/ar-original.html',
                    to: 'ar-original.html',
                    noErrorOnMissing: true
                },
                {
                    from: 'public/*.webm',
                    to: '[name][ext]',
                    noErrorOnMissing: true
                },
                {
                    from: 'public/*.mp4',
                    to: '[name][ext]',
                    noErrorOnMissing: true
                },
                {
                    from: 'public/_headers',
                    to: '_headers',
                    toType: 'file',
                    noErrorOnMissing: true
                }
            ]
        })
    ],
    resolve: {
        extensions: ['.js']
    }
};