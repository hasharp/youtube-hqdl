/* jshint node: true, esnext: true */
'use strict';

const https = require('https');
const net   = require('net');
const path  = require('path');
const spawn = require('child_process').spawn;
const vm    = require('vm');

const extend      = require('extend');
const cheerio     = require('cheerio');
const libSanitize = require('sanitize-filename');
const querystring = require('querystring');


class YtdlEmitter extends require('events') {}

function sanitize(fileName, replacement) {
    replacement = replacement || '';
    fileName = libSanitize(fileName, {
        replacement: replacement,
    });
    fileName = fileName.replace(replacement ? /\.$/ : /\.+$/, replacement);
    return fileName;
}

function fetch(url, callback) {
    https.get(url, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
            data += chunk;
        });
        res.on('end', () => {
            callback(true, data);
        });
    }).on('error', error => {
        callback(false, error);
    });
}

function generatePipePath() {
    let randomName = `np_t${Date.now()}r${Math.random().toString().replace(/^0\./, '')}`;
    return path.join(process.platform === 'win32' ? '\\\\?\\pipe' : '/tmp/pipe', randomName);
}

function download(options) {
    // YtdlEmitter作成
    let emitter = new YtdlEmitter();
    // パイプ作成
    let pipes = {};
    ['audio', 'video'].forEach(type => {
        let path = generatePipePath();
        let server = net.createServer(connection => {
            https.get(options.urls[type], res => {
                res.pipe(connection);
            });
        }).listen(path);
        pipes[type] = {
            path:   path,
            server: server,
        };
    });
    // FFmpeg用メタデータオプション作成
    let metaDataForFFmpeg = [];
    if (options.metaData) {
        for (let i in options.metaData) {
            metaDataForFFmpeg.push('-metadata');
            let metaContent = typeof(options.metaData[i]) === 'string' ? options.metaData[i] : options.metaData[i](options.videoInfo);
            metaDataForFFmpeg.push(`"${i}"="${metaContent}"`);
        }
    }
    // FFmpeg実行
    let ffmpeg = spawn('ffmpeg', [].concat(
        // 入力の設定
        [
            '-i', pipes.audio.path,
            '-i', pipes.video.path,
        ],
        // コーデックの設定
        [
            '-c', 'copy',
        ],
        // 追加の設定
        options.additionalOptions || [],
        // メタデータの設定
        metaDataForFFmpeg,
        // 出力の設定
        // シーク可能でなければならないので、標準出力やパイプは使えない
        [
            options.outputPath,
        ],
        // ダミー
        []
    ));
    // エンコード状況取得
    let duration = NaN;
    let getDurMode = false;
    ffmpeg.stderr.on('data', data => {
        // 解析用関数
        function parseSize(str) {
            function getK(unit) {
                let units = ['b', 'k', 'm', 'g', 't', 'p'];
                for (let i = 0; i < units.length; i++) {
                    if (unit === units[i].toLowerCase()) return Math.pow(1000, i);
                    if (unit === units[i].toUpperCase()) return Math.pow(1024, i);
                }
                return 1;
            }
            let unit  = str.match(/[a-z]/i);
            let isBit = str.match(/bit/i);
            return parseFloat(str) * getK(unit) / (isBit ? 8 : 1);
        }
        function parseTime(str) {
            let time = str.match(/(\d{2}):(\d{2}):(\d{2}\.\d{1,2})/);
            return (parseInt(time[1]) * 60 + parseInt(time[2])) * 60 + parseFloat(time[3]);
        }
        // 解析
        let strData = data.toString();
        if (strData.match(/Duration:/)) {
            getDurMode = true;
        }
        if (getDurMode) {
            let strDuration = strData.match(/\d{2}:\d{2}:\d{2}\.\d{1,2}/);
            if (strDuration) {
                getDurMode = false;
                let tmpDuration = parseTime(strDuration.toString());
                if (isNaN(duration) || duration < tmpDuration) duration = tmpDuration;
            }
        }
        if (strData.match(/^frame=/)) {
            // rawInfo作成
            let splitInfo = strData.replace(/[\r\n]+[\s\S]+/g, '').split(/=\s*|\s+/);
            let rawInfo = {};
            for (let i = 0; i < splitInfo.length; i += 2) {
                rawInfo[splitInfo[i]] = splitInfo[i + 1];
            }
            // info作成
            let info = {
                frame:   parseInt(rawInfo.frame),
                fps:     parseFloat(rawInfo.fps),
                q:       parseFloat(rawInfo.q),
                time:    parseTime(rawInfo.time),
                bitrate: parseSize(rawInfo.bitrate),
                speed:   parseFloat(rawInfo.speed),
            };
            let sizeKey = rawInfo.size ? 'size' : 'Lsize';
            info[sizeKey] = parseSize(rawInfo[sizeKey]);
            // obj作成
            let obj = {
                progress: info.time / duration,
                info:     info,
                rawData:  strData,
                rawInfo:  rawInfo,
            };
            // emit
            emitter.emit('update', obj);
        }
    });
    // 終了処理
    ffmpeg.on('close', () => {
        ['audio', 'video'].forEach(type => {
            pipes[type].server.close();
        });
        emitter.emit('done');
    });
    return emitter;
}

function fetchInfo(videoId, callback) {
    fetch(`https://www.youtube.com/watch?v=${videoId}`, (success, data) => {
        if (!success) {
            callback(success, data);
            return;
        }
        let $ = cheerio.load(data);
        // スクリプトを検索・実行してデータ取得
        let script = $('script:contains(ytplayer)').text();
        let context = {
            window: {},
        };
        vm.runInNewContext(script, context);
        if (!context.ytplayer) {
            callback(false, context);
            return;
        }
        // メタ情報検索
        let schema = {};
        let $container = $('*[itemscope][itemtype$=VideoObject]');
        // とりあえず全般的なmetaタグのmicrodataを取得
        $container.children('meta[itemprop][content]').each((index, element) => {
            let $element = $(element);
            schema[$element.attr('itemprop')] = $element.attr('content');
        });
        // 投稿者情報を取得
        let authorLinks = [];
        $container.children('span[itemprop=author]').children('link[itemprop=url]').each((index, element) => {
            let $element = $(element);
            authorLinks.push($element.attr('href'));
        });
        // 完全な説明を取得
        let description = $('#eow-description').text();
        // コールバック呼ぶ
        callback(true, {
            schema:      schema,
            authorLinks: authorLinks,
            description: description,
            ytplayer:    context.ytplayer,
        });
    });
}


function downloader(videoId, options, callback) {
    options = extend({
        outputDir: process.cwd(),
        outputFileName: videoInfo => `${videoInfo.args.title} [${videoInfo.videoId}].${videoInfo.extension}`,
        targetFormats: [
            'mp4',
            'webm',
        ],
        additionalOptions: {
            mp4: [
                // moov atomを先頭に移動させる
                '-movflags', 'faststart',
            ],
            webm: [
                // 特に無し
            ],
        },
        metaData: {
            title:   videoInfo => videoInfo.args.title,
            author:  videoInfo => videoInfo.args.author,
            artist:  videoInfo => videoInfo.args.author,
            genre:   videoInfo => videoInfo.schema.genre,
            date:    videoInfo => videoInfo.schema.datePublished,
            year:    videoInfo => videoInfo.schema.datePublished.match(/\d{4}/),
            comment: videoInfo => `https://youtu.be/${videoInfo.videoId}\n\n${videoInfo.description}`,
        },
        formatFilter: formatInfo => {
            // Vorbisは使わない（Opusのほうが高音質なので）
            if (formatInfo.type === 'audio' && formatInfo.format === 'webm' && formatInfo.codec === 'vorbis') return false;
            // それ以外の形式は使う
            return true;
        },
        compareSource: (a, b) => (parseInt(a.bitrate) < parseInt(b.bitrate)),
    }, options);
    // 処理
    fetchInfo(videoId, (success, data) => {
        if (!success) {
            callback(success, data);
            return;
        }
        // 情報取得
        let args = data.ytplayer.config.args;
        let fmts = {};
        args.adaptive_fmts.split(',').forEach(element => {
            let fmtObj = querystring.parse(element);
            let parsedType = fmtObj.type.match(/^\s*(\w+)\/(\w+)(?:;\s*codecs=["']([^"']+)["'])?\s*$/i);
            let type   = parsedType[1];
            let format = parsedType[2];
            let codec  = parsedType[3];
            if (!fmts[format]) fmts[format] = {};
            if (!fmts[format][type]) fmts[format][type] = [];
            // コーデック情報を追加
            fmtObj.codec = codec;
            // 追加
            fmts[format][type].push(fmtObj);
        });
        // フォーマットごとに処理
        let emitters = {};
        options.targetFormats.forEach(targetFormat => {
            let fmt = fmts[targetFormat];
            if (!fmt) {
                return;
            }
            let sources = {};
            ['audio', 'video'].forEach(type => {
                sources[type] = {};
                fmt[type].forEach(source => {
                    if (options.formatFilter) {
                        let formatInfo = {
                            type:    type,
                            format:  targetFormat,
                            codec:   source.codec,
                            bitrate: parseInt(source.bitrate),
                            source:  source,
                        };
                        if (!options.formatFilter(formatInfo)) {
                            return;
                        }
                    }
                    if (!sources[type].url || options.compareSource(sources[type], source)) {
                        sources[type] = source;
                    }
                });
            });
            // videoInfo作成
            let videoInfo = {
                videoId:      videoId,
                description:  data.description,
                targetFormat: targetFormat,
                extension:    targetFormat,
                args:         args,
                schema:       data.schema,
                sources:      sources,
            };
            // 出力パス作成
            let directory = typeof(options.outputDir) === 'string' ? options.outputDir : options.outputDir(videoInfo);
            let fileName = typeof(options.outputFileName) === 'string' ? options.outputFileName : options.outputFileName(videoInfo);
            let filePath = path.join(directory, sanitize(fileName));
            // 追加オプション取得
            let additionalOptions = null;
            if (options.additionalOptions) {
                additionalOptions = typeof(options.additionalOptions) === 'function' ? options.additionalOptions(videoInfo) : options.additionalOptions[targetFormat];
            }
            // メタデータ取得
            let metaData = null;
            if (options.metaData) {
                metaData = typeof(options.metaData) === 'function' ? options.metaData(videoInfo) : options.metaData;
            }
            // ダウンロード
            emitters[targetFormat] = download({
                format:            targetFormat,
                urls: {
                    audio: sources.audio.url,
                    video: sources.video.url,
                },
                outputPath:        filePath,
                metaData:          metaData,
                additionalOptions: additionalOptions,
                formatFilter:      options.formatFilter,
                sources:           sources,
                videoInfo:         videoInfo,
            });
        });
        // コールバック呼び出し
        let videoInfo = {
            videoId:     videoId,
            description: data.description,
            args:        args,
            schema:      data.schema,
        };
        callback(true, {
            videoInfo: videoInfo,
            emitters:  emitters,
        });
    });
}

module.exports = downloader;