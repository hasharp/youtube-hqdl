/* jshint node: true, esnext: true */
'use strict';

const downloader = require('./downloader');


function writeProgressBar(progress) {
    const len = 70;
    const size = Math.round(len * progress);
    process.stdout.write(`[${'#'.repeat(size)}${' '.repeat(len-size)}]`);
}

function download() {
    let target    = process.argv[2];
    let outputDir = process.argv[3] || process.cwd();
    let format    = process.argv[4] || 'both';

    // 動画ID取得
    let videoId;
    const rxYtId  = /^[\w-]{11}$/;
    const rxYtUrl = /^(?:(?:(?:h?ttps?)?:)?\/\/)?(?:youtu\.be\/|(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:.+&)?v=|v\/|e(?:mbed)?\/))([\w-]{11})/i;
    if (target.match(rxYtId)) {
        videoId = target;
    } else if (target.match(rxYtUrl)) {
        videoId = target.match(rxYtUrl)[1];
    } else {
        console.error(`Unknown target "${target}".`);
        process.exit(1);
        return;
    }
    // 一応チェック
    if (!videoId.match(rxYtId)) {
        console.error(`Regex error "${videoId}".`);
        process.exit(10);
        return;
    }
    // フォーマット取得
    let targetFormats;
    switch (format) {
        case 'mp4':
            targetFormats = ['mp4'];
            break;
        case 'webm':
            targetFormats = ['webm'];
            break;
        case 'both':
            targetFormats = [
                'mp4',
                'webm',
            ];
            break;
        default:
            console.error(`Unknown format "${format}"`);
            process.exit(2);
            return;
    }
    // ダウンロード
    downloader(videoId, {
        outputDir:     outputDir,
        targetFormats: targetFormats,
    }, (success, res) => {
        if (!success) {
            console.error('Error');
            console.error(res);
            process.exit(11);
            return;
        }
        //
        let emitters = res.emitters;
        let videoInfo = res.videoInfo;
        console.log(`Download "${videoInfo.args.title}" (${videoInfo.videoId}) to "${outputDir}".`);
        //
        let idToY = {};
        let x = 0;
        let y = 0;
        for (let i in emitters) {
            x = Math.max(x, i.length);
            idToY[i] = y++;
            console.log(i);
        }
        x++;
        //
        for (let i in emitters) {
            emitters[i].on('update', info => {
                process.stdout.moveCursor(0, idToY[i] - y);
                process.stdout.cursorTo(x);
                writeProgressBar(info.progress);
                process.stdout.moveCursor(0, y - idToY[i]);
                process.stdout.cursorTo(0);
            });
            /*
            emitters[i].on('done', () => {
            });
            */
        }
    });
}

download();