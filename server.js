require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fs = require("fs-extra");
const path = require("path");


const ytdl = require("ytdl-core");

const converter = require("video-converter");
const ffmetadata = require("ffmetadata");
const ffmpeg = require("ffmpeg");
const CliProgress = require("cli-progress");
const albumart = require("album-art");
const imagedownload = require("image-downloader");
const streamtoblob = require("stream-to-blob");

const uuid = require("uuid");

var YouTube = require("youtube-node");

var youtube = new YouTube();
youtube.setKey(process.env.API_KEY);

const port = process.env.PORT;
const app = express();

const http = require("http").createServer(app);

const io = require("socket.io")(https);

io.on("connection", socket => {
    console.log(`${socket.id} connected.`);

    socket.on("send-friend-request", data => {
        console.log("FRIEND REQUEST => " + data.date);
    });

    socket.on("disconnect", () => {
        console.log(`${socket.id} disconnected.`);
    });
});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cors({ origin: '*' }));

app.use(express.static(path.join(__dirname, "public")));

app.set("view engine", "pug");

app.get("/", (req, res) => {
    return res.render("index", {
        title: "Pensive | Home",
        appName: "Pensive",
        message: "Hello from server!"
    });
});

app.get("/app/luider", (req, res) => {
    res.sendFile(path.join(__dirname, "luider", "index.html"));
});

app.get("/api/luider", (req, res) => {
    const query = req.query;

    if (!(query.q || query.d || query.id || query.e))
        return res.render("luider", {
            title: "Pensive | Luider",
            appName: "Luider"
        });

    if (query.q)
        search(query.q)
            .then(list => {
                res.render('luider-list', { title: "Pensive | Luider", appName: "Luider", list })
            })
            .catch(err => console.log(err));

    if (query.e)
        getInfo(query.e, (url, info) => {
            res.render('luider-edit', { title: "Pensive | Luider", appName: "Luider", info });
        });


});

app.post("/api/luider", async (req, res) => {
    const query = req.query;

    if (query.id && query.d) {
        getInfo(query.id, async (url, info) => {
            // download(url, req.body).then(file => {
            //     res.download(file);
            // }).catch(err => console.log(err));

            const stream = ytdl(url, { filter: 'audioonly' });

            res.setHeader('content-type', 'application/octet-stream');
            res.writeHead(200);

            stream.on("data", (chunk) => {
                res.write(chunk);
            });

            stream.on("end", () => {
                res.send();
            });
        });
    }
});

http.listen(port, () => {
    console.log(`Server running on: ${port}`);

    fs.emptyDirSync("cache");
    fs.emptyDirSync("completed");
});

function search(name) {
    return new Promise((resolve, reject) => {
        var youTube = new YouTube();

        youTube.setKey("AIzaSyB1OOSpTREs85WUMvIgJvLTZKye4BVsoFU");

        youTube.addParam("order", "relevance");

        youTube.search(name, 50, function (error, result) {
            if (error) {
                reject(error);
            } else {
                var list = [];
                var videos = result.items;
                // add "videos" to "list"
                for (var i = 0; i < videos.length; i++) {
                    const song = videos[i];

                    const videoId = song.id.videoId;
                    const channel = song.snippet.channelTitle; // format {channel} || {video_title} ({timestamp})
                    const title = song.snippet.title; // extract title
                    const description = song.snippet.description;
                    const thumbnail = song.snippet.thumbnails.high.url;
                    const kind = song.id.kind.replace("youtube#", "");

                    list.push({
                        channel,
                        title,
                        description,
                        thumbnail,
                        videoId,
                        kind
                    }); // push video to list
                }
                resolve(list);
            }
        });
    });
}

// configure progress bar
var p = new CliProgress.SingleBar({
    format: 'CLI Progress | {bar} | {percentage}% || {value}/{total} Chunks || Speed: {speed}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
    fps: 240,
    clearOnComplete: true,
    stopOnComplete: true
});

function download(url, meta) {
    return new Promise((resolve, reject) => {
        const tempname = uuid.v4();
        const temp = fs.createWriteStream("cache/" + tempname + ".mp4");
        temp.on("open", (fd) => {
            // http.get(url, (res) => console.log(res));
            ytdl(url, {
                filter: format => format.container === "mp4",
                quality: "highestaudio"
            }).on("response", res => {
                var length = res.headers["content-length"];
                var read = 0;

                p.start(length)

                res.on("data", data => {
                    read += data.length;
                    p.update(read);
                });

                res.on("end", () => {
                    p.stop();
                });
            })
                .pipe(fs.createWriteStream("cache/" + tempname + ".mp4")) // write stream to cache
                .on("close", () => {
                    converter.convert(
                        "cache/" + tempname + ".mp4",
                        "completed/" + tempname + ".mp3",
                        err => {
                            if (err) reject(err);

                            const title = meta.title;
                            const album = meta.album;
                            const artist = meta.artist;

                            const art_url = albumart(`${artist}`, {
                                album: `${album}`,
                                size: "extreme"
                            });

                            art_url.then(res => {
                                if (res.toString().startsWith("http")) {
                                    // download remote image
                                    imagedownload
                                        .image({
                                            url: res.replace("300x300", "1080x1080"),
                                            dest: "cache"
                                        })
                                        .then(({ filename, image }) => {
                                            // write song info to mp3
                                            ffmetadata.write(
                                                "completed/" + tempname + ".mp3",
                                                {
                                                    artist: artist,
                                                    title: title,
                                                    album: album
                                                },
                                                {
                                                    attachments: [filename]
                                                },
                                                function (err) {
                                                    if (err) {
                                                        reject(err)
                                                    } else {
                                                        resolve("completed/" + tempname + ".mp3");

                                                        setTimeout(() => {
                                                            // delete mp4 from cache
                                                            fs.unlinkSync("cache/" + tempname + ".mp4");

                                                            // complete
                                                            fs.unlinkSync(filename);
                                                            // fs.unlinkSync("completed/" + tempname + ".mp3");
                                                        }, 2000);
                                                    }
                                                }
                                            );
                                        })
                                        .catch(err => reject(err));
                                } else {
                                    ffmetadata.write(
                                        "completed/" + tempname + ".mp3",
                                        {
                                            artist: artist,
                                            title: title,
                                            album: album
                                        },
                                        {
                                            attachments: ["cover.jpg"]
                                        },
                                        function (err) {
                                            if (err) {
                                                reject(err);
                                            } else {
                                                resolve("completed/" + tempname + ".mp3");

                                                setTimeout(() => {
                                                    // delete mp4 from cache
                                                    fs.unlinkSync("cache/" + tempname + ".mp4");

                                                    // complete
                                                    // fs.unlinkSync("completed/" + tempname + ".mp3");
                                                }, 2000);
                                            }
                                        }
                                    );
                                }
                            });
                        }
                    );
                })
        })
    });
}

// getinfo function
function getInfo(id, callback) {
    ytdl.getInfo(id, (err, info) => {
        if (err) throw err;

        // begin download
        callback(info.video_url, info);
    });
}