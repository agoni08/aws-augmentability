/*
Original Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved. 
Modifications Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

const audioUtils = require("./audioUtils"); // for encoding audio data as PCM
const crypto = require("crypto"); // tot sign our pre-signed URL
const v4 = require("./aws-signature-v4"); // to generate our pre-signed URL
const marshaller = require("@aws-sdk/eventstream-marshaller"); // for converting binary event stream messages to and from JSON
const util_utf8_node = require("@aws-sdk/util-utf8-node"); // utilities for encoding and decoding UTF8
const mic = require("microphone-stream"); // collect microphone input as a stream of raw bytes

// Initialize the Amazon Cognito credentials provider
AWS.config.region = appConfig.region; // Region
AWS.config.credentials = new AWS.CognitoIdentityCredentials({
    IdentityPoolId: appConfig.IdentityPoolId,
});

// As of v2.1.20 the credentials are fetched lazily when a request is made. To explicitly get credentials you can use AWS.Credentials.get()
AWS.config.credentials.get(function (err) {
    if (err) console.log(err);
    //  else console.log(AWS.config.credentials);
});

// our converter between binary event streams messages and JSON
const eventStreamMarshaller = new marshaller.EventStreamMarshaller(
    util_utf8_node.toUtf8,
    util_utf8_node.fromUtf8
);

// our global variables for managing state
let languageCode;
let region = "eu-central-1";
let sampleRate;
let inputSampleRate;
let transcription = "";
let socket;
let micStream;
let socketError = false;
let transcribeException = false;
let translation = "";
let translation2 = "";

let translated;

const pollyVoiceMap = new Map();
pollyVoiceMap.set("ar", "Zeina");
pollyVoiceMap.set("zh", "Zhiyu");
pollyVoiceMap.set("zh-TW", "Zhiyu");
pollyVoiceMap.set("da", "Mads");
pollyVoiceMap.set("nl", "Ruben");
pollyVoiceMap.set("en", "Matthew");
pollyVoiceMap.set("fr", "Mathieu");
pollyVoiceMap.set("fr-CA", "Chantal");
pollyVoiceMap.set("de", "Hans");
pollyVoiceMap.set("hi", "Aditi");
pollyVoiceMap.set("is", "Karl");
pollyVoiceMap.set("it", "Bianca");
pollyVoiceMap.set("ja", "Takumi");
pollyVoiceMap.set("ko", "Seoyeon");
pollyVoiceMap.set("no", "Liv");
pollyVoiceMap.set("pl", "Jacek");
pollyVoiceMap.set("pt", "Cristiano");
pollyVoiceMap.set("ro", "Carmen");
pollyVoiceMap.set("ru", "Maxim");
pollyVoiceMap.set("es", "Conchita");
pollyVoiceMap.set("es-MX", "Mia");
pollyVoiceMap.set("es-US", "Miguel");
pollyVoiceMap.set("sv", "Astrid");
pollyVoiceMap.set("tr", "Filiz");
pollyVoiceMap.set("cy", "Gwyneth");
pollyVoiceMap.set("en-US", "Matthew");
pollyVoiceMap.set("en-GB", "Amy");
pollyVoiceMap.set("en-AU", "Russell");
pollyVoiceMap.set("fr-FR", "Mathieu");
pollyVoiceMap.set("pt-BR", "Camila");
pollyVoiceMap.set("de-DE", "Hans");
pollyVoiceMap.set("ja-JP", "Takumi");
pollyVoiceMap.set("it-IT", "Bianca");
pollyVoiceMap.set("ko-KR", "Seoyeon");
pollyVoiceMap.set("zh-CN", "Zhiyu");
pollyVoiceMap.set("es-US", "Miguel");

// check to see if the browser allows mic access
if (!window.navigator.mediaDevices.getUserMedia) {
    // Use our helper method to show an error on the page
    showError(
        "We support the latest versions of Chrome, Firefox, Safari, and Edge. Update your browser and try your request again."
    );
}

// components visibility initialization
if (
    typeof document.getElementById("stop-button") != "undefined" &&
    document.getElementById("stop-button") != null
)
    document.getElementById("stop-button").style.display = "none";

if (
    typeof document.getElementById("stop-conversation-button") != "undefined" &&
    document.getElementById("stop-conversation-button") != null
)
    document.getElementById("stop-conversation-button").style.display = "none";

if (
    typeof document.getElementById("audioPlayback") != "undefined" &&
    document.getElementById("audioPlayback") != null
)
    document.getElementById("audioPlayback").style.display = "none";

if (
    typeof document.getElementById("show-text") != "undefined" &&
    document.getElementById("show-text") != null
)
    document.getElementById("show-text").style.display = "none";

if (
    typeof document.getElementById("text-container") != "undefined" &&
    document.getElementById("text-container") != null
)
    document.getElementById("text-container").style.display = "none";

$("#start-button").click(function () {
    $("#error").hide(); // hide any existing errors
    toggleStartStop(); // disable start and enable stop button
    setLanguage(); // set the language and region from the dropdowns
    window.navigator.mediaDevices
        .getUserMedia({
            // first we get the microphone input from the browser (as a promise)
            video: false,
            audio: true,
        })
        .then(streamAudioToWebSocket) // we convert the mic stream to binary event stream messages when the promise resolves
        .catch(function (error) {
            showError(
                "There was an error streaming your audio to Amazon Transcribe. Please try again."
            );
            console.log(error);
            toggleStartStop();
        });
});

$("#start-conversation-button").click(function () {
    $("#error").hide(); // hide any existing errors
    toggleStartStop2(); // disable start and enable stop button
    setLanguage(); // set the language and region from the dropdowns
    window.navigator.mediaDevices
        .getUserMedia({
            // first we get the microphone input from the browser (as a promise)
            video: false,
            audio: true,
        })
        .then(streamAudioToWebSocket) // we convert the mic stream to binary event stream messages when the promise resolves
        .catch(function (error) {
            showError(
                "There was an error streaming your audio to Amazon Transcribe. Please try again."
            );
            console.log(error);
            toggleStartStop2();
        });
});

$("#hide-container").click(function () {
    if (
        typeof document.getElementById("text-container") != "undefined" &&
        document.getElementById("text-container") != null
    )
        document.getElementById("text-container").style.display = "none";
});

$("#show-text").click(function () {
    document.getElementById("text-container").style.display = "block";
});

let streamAudioToWebSocket = function (userMediaStream) {
    micStream = new mic(); //let's get the mic input from the browser, via the microphone-stream module

    micStream.on("format", function (data) {
        inputSampleRate = data.sampleRate;
    });

    micStream.setStream(userMediaStream);

    let url = createPresignedUrl(); // Pre-signed URLs are a way to authenticate a request (or WebSocket connection, in this case)
    socket = new WebSocket(url); // open up our WebSocket connection
    socket.binaryType = "arraybuffer";
    let sampleRate = 0;
    socket.onopen = function () {
        // when we get audio data from the mic, send it to the WebSocket if possible
        micStream.on("data", function (rawAudioChunk) {
            let binary = convertAudioToBinaryMessage(rawAudioChunk); // the audio stream is raw audio bytes. Transcribe expects PCM with additional metadata, encoded as binary
            if (socket.readyState === socket.OPEN) socket.send(binary);
        });
    };
    wireSocketEvents(); // handle messages, errors, and close events
};

function setLanguage() {
    languageCode = $("#language").find(":selected").val();
    if (languageCode == "en-US" || languageCode == "es-US") sampleRate = 44100;
    else sampleRate = 8000;
}

function disableLanguage() {
    var currentLanguage;
    currentLanguage = $("#language").find(":selected").val().substring(0, 2);
    //console.log(currentLanguage);
    $("#translateTo option").each(function (index, element) {
        if (currentLanguage == element.value) {
            $(this).prop("disabled", true);
        } else {
            $(this).prop("disabled", false);
        }
    });
}

function formatTranslate() {
    var currentLanguage = $("#translateTo").find(":selected").val();
    if (currentLanguage == "he" || currentLanguage == "ar") {
        $("#translate").css("direction", "rtl");
    } else {
        $("#translate").css("direction", "ltr");
    }
}

function speakText() {
    setLanguage();

    if (typeof pollyVoiceMap.get(languageCode) === "undefined") {
        document.getElementById("result").innerHTML =
            "The language you selected is not available for text-to-speech";
        return;
    }

    var voiceId = pollyVoiceMap.get(languageCode);

    // Create the JSON parameters for getSynthesizeSpeechUrl
    var speechParams = {
        OutputFormat: "mp3",
        SampleRate: "16000",
        Text: "",
        TextType: "text",
        VoiceId: voiceId,
    };
    speechParams.Text = document.getElementById("textEntry").value;

    // Create the Polly service object and presigner object
    var polly = new AWS.Polly({ apiVersion: "2016-06-10" });
    var signer = new AWS.Polly.Presigner(speechParams, polly);

    // Create presigned URL of synthesized speech file
    signer.getSynthesizeSpeechUrl(speechParams, function (error, url) {
        if (error) {
            document.getElementById("result").innerHTML = error;
        } else {
            document.getElementById("audioSource").src = url;
            if (
                document.getElementById("audioPlayback").style.display ===
                "none"
            )
                document.getElementById("audioPlayback").style.display =
                    "block";
            document.getElementById("audioPlayback").load();
            document.getElementById("result").innerHTML = "Ready!";
        }
    });
}

function translateSpeakText() {
    $("#translate2").val("");
    setLanguage();

    if (typeof pollyVoiceMap.get(languageCode) === "undefined") {
        document.getElementById("result").innerHTML =
            "The language you selected is not available for text-to-speech";
        return;
    }

    var voiceId = pollyVoiceMap.get(languageCode);

    // Create the JSON parameters for getSynthesizeSpeechUrl
    var speechParams = {
        OutputFormat: "mp3",
        SampleRate: "16000",
        Text: "",
        TextType: "text",
        VoiceId: voiceId,
    };

    translation2 = "";

    translateInputReverse(
        document.getElementById("textEntry").value,
        function (translated) {
            translation2 += translated + "\n";
            //$('#translate').val(translation + "\n");
            $("#translate2").val(translation2 + "\n");
            //$('#translate2').scrollTop($('#translate2')[0].scrollHeight);
            speechParams.Text = translation2;

            // Create the Polly service object and presigner object
            var polly = new AWS.Polly({ apiVersion: "2016-06-10" });
            var signer = new AWS.Polly.Presigner(speechParams, polly);

            // Create presigned URL of synthesized speech file
            signer.getSynthesizeSpeechUrl(speechParams, function (error, url) {
                if (error) {
                    document.getElementById("result").innerHTML = error;
                } else {
                    document.getElementById("audioSource").src = url;
                    if (
                        document.getElementById("audioPlayback").style
                            .display === "none"
                    )
                        document.getElementById("audioPlayback").style.display =
                            "block";
                    document.getElementById("audioPlayback").load();
                    document.getElementById("result").innerHTML = "Ready!";
                }
            });
        }
    );
}

function conversationSpeak() {
    setTimeout(() => {
        if (
            typeof pollyVoiceMap.get(
                $("#translateTo").find(":selected").val()
            ) === "undefined"
        ) {
            document.getElementById("result").innerHTML =
                "The language you selected is not available for text-to-speech";
            return;
        }

        var voiceId = pollyVoiceMap.get(
            $("#translateTo").find(":selected").val()
        );

        // Create the JSON parameters for getSynthesizeSpeechUrl
        var speechParams = {
            OutputFormat: "mp3",
            SampleRate: "16000",
            Text: translation,
            TextType: "text",
            VoiceId: voiceId,
        };

        // Create the Polly service object and presigner object
        var polly = new AWS.Polly({ apiVersion: "2016-06-10" });
        var signer = new AWS.Polly.Presigner(speechParams, polly);

        // Create presigned URL of synthesized speech file
        signer.getSynthesizeSpeechUrl(speechParams, function (error, url) {
            if (error) {
                document.getElementById("result").innerHTML = error;
            } else {
                document.getElementById("audioSource").src = url;
                if (
                    document.getElementById("audioPlayback").style.display ===
                    "none"
                )
                    document.getElementById("audioPlayback").style.display =
                        "block";
                document.getElementById("audioPlayback").load();
                //document.getElementById('result').innerHTML = "Ready!";
            }
        });
    }, 1000);
}

function speakDetectedTextFromWebcam(detectedText, language) {
    setLanguage();
    var voiceId = pollyVoiceMap.get(language);

    // Create the JSON parameters for getSynthesizeSpeechUrl
    var speechParams = {
        OutputFormat: "mp3",
        SampleRate: "16000",
        Text: "",
        TextType: "text",
        VoiceId: voiceId,
    };
    speechParams.Text = detectedText;

    // Create the Polly service object and presigner object
    var polly = new AWS.Polly({ apiVersion: "2016-06-10" });
    var signer = new AWS.Polly.Presigner(speechParams, polly);

    // Create presigned URL of synthesized speech file
    signer.getSynthesizeSpeechUrl(speechParams, function (error, url) {
        if (error) {
            console.log(error);
        } else {
            document.getElementById("audioSource").src = url;
            document.getElementById("audioPlayback").load();
        }
    });
}

function wireSocketEvents() {
    // handle inbound messages from Amazon Transcribe
    socket.onmessage = function (message) {
        //convert the binary event stream message to JSON
        let messageWrapper = eventStreamMarshaller.unmarshall(
            Buffer(message.data)
        );
        let messageBody = JSON.parse(
            String.fromCharCode.apply(String, messageWrapper.body)
        );
        if (messageWrapper.headers[":message-type"].value === "event") {
            handleEventStreamMessage(messageBody);
        } else {
            transcribeException = true;
            showError(messageBody.Message);
            toggleStartStop();
        }
    };

    socket.onerror = function () {
        socketError = true;
        showError("WebSocket connection error. Try again.");
        toggleStartStop();
    };

    socket.onclose = function (closeEvent) {
        micStream.stop();

        // the close event immediately follows the error event; only handle one.
        if (!socketError && !transcribeException) {
            if (closeEvent.code != 1000) {
                showError(
                    "</i><strong>Streaming Exception</strong><br>" +
                        closeEvent.reason
                );
                toggleStartStop();
            }
        }
    };
}

let handleEventStreamMessage = function (messageJson) {
    let results = messageJson.Transcript.Results;
    if (results.length > 0) {
        if (results[0].Alternatives.length > 0) {
            location.href = "#";
            location.href = "#transcription-div";
            let transcript = results[0].Alternatives[0].Transcript;

            // fix encoding for accented characters
            transcript = decodeURIComponent(escape(transcript));
            // update the textarea with the latest result

            $("#transcript").val(transcription + transcript + "\n");
            //$('#transcript').scrollTop($('#transcript')[0].scrollHeight);

            // if this transcript segment is final, add it to the overall transcription
            if (!results[0].IsPartial) {
                //scroll the textarea down
                //$('#transcript').scrollTop($('#transcript')[0].scrollHeight);
                transcription += transcript + "\n";

                if (
                    typeof document.getElementById("translateTo") !=
                        "undefined" &&
                    document.getElementById("translateTo") != null
                )
                    translateInput(transcript, function (translated) {
                        location.href = "#";
                        location.href = "#translate-div";

                        //console.log(translated);
                        translation += translated + "\n";
                        //$('#translate').val(translation + "\n");

                        $("#translate").val(translation + "\n");
                        //$('#translate').scrollTop($('#translate')[0].scrollHeight);
                    });
            }
        }
    }
};

let closeSocket = function () {
    if (socket.readyState === socket.OPEN) {
        micStream.stop();

        // Send an empty frame so that Transcribe initiates a closure of the WebSocket after submitting all transcripts
        let emptyMessage = getAudioEventMessage(Buffer.from(new Buffer([])));
        let emptyBuffer = eventStreamMarshaller.marshall(emptyMessage);
        socket.send(emptyBuffer);
    }
};

function translateInput(text, callback) {
    //var source_language = document.getElementById('source_lang');
    var source_language = "auto";
    var target_language = $("#translateTo")
        .find(":selected")
        .val()
        .substring(0, 2);

    var urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has("language")) {
        var target_language = urlParams.get("language");
    }

    var translate = new AWS.Translate();
    var params = {
        SourceLanguageCode: source_language,
        TargetLanguageCode: target_language,
        Text: text,
    };
    translate.translateText(params, function (err, data) {
        //console.log(data);
        callback(data.TranslatedText);
    });
}

function translateInputReverse(text, callback) {
    //var source_language = document.getElementById('source_lang');
    var source_language = $("#translateTo")
        .find(":selected")
        .val()
        .substring(0, 2);
    var target_language = $("#language")
        .find(":selected")
        .val()
        .substring(0, 2);

    var translate = new AWS.Translate();
    var params = {
        SourceLanguageCode: source_language,
        TargetLanguageCode: target_language,
        Text: text,
    };
    translate.translateText(params, function (err, data) {
        //console.log(data);
        callback(data.TranslatedText);
    });
}

$("#stop-button").click(function () {
    closeSocket();
    toggleStartStop();
});

$("#reset-button").click(function () {
    $("#transcript").val("");
    transcription = "";
    $("#translate").val("");
    translation = "";
});

$("#reset-button-2").click(function () {
    $("#translate2").val("");
    translation2 = "";
});

$("#play-button").click(function () {
    speakText();
});

$("#translate-play-button").click(function () {
    translateSpeakText();
});

$("#switch-language-button").click(function () {
    let language0 = document.getElementById("language").selectedIndex;
    let translateTo0 = document.getElementById("translateTo").selectedIndex;
    document.getElementById("language").selectedIndex = translateTo0;
    document.getElementById("translateTo").selectedIndex = language0;
    disableLanguage();
    formatTranslate();
});

$("#language").change(function () {
    disableLanguage();
});

$("#translateTo").change(function () {
    formatTranslate();
});

$("#stop-conversation-button").click(function () {
    closeSocket();
    toggleStartStop2();
    conversationSpeak();
});

function toggleStartStop() {
    if (document.getElementById("start-button").style.display === "none") {
        document.getElementById("start-button").style.display = "block";
    } else {
        document.getElementById("start-button").style.display = "none";
    }

    if (document.getElementById("stop-button").style.display === "none") {
        document.getElementById("stop-button").style.display = "block";
    } else {
        document.getElementById("stop-button").style.display = "none";
    }
}

function toggleStartStop2(disableStart = false) {
    if (
        document.getElementById("start-conversation-button").style.display ===
        "none"
    ) {
        document.getElementById("start-conversation-button").style.display =
            "block";
    } else {
        document.getElementById("start-conversation-button").style.display =
            "none";
    }

    if (
        document.getElementById("stop-conversation-button").style.display ===
        "none"
    ) {
        document.getElementById("stop-conversation-button").style.display =
            "block";
    } else {
        document.getElementById("stop-conversation-button").style.display =
            "none";
    }
}

function showError(message) {
    $("#error").html('<i class="fa fa-times-circle"></i> ' + message);
    $("#error").show();
}

function convertAudioToBinaryMessage(audioChunk) {
    let raw = mic.toRaw(audioChunk);
    if (raw == null) return;

    // downsample and convert the raw audio bytes to PCM
    let downsampledBuffer = audioUtils.downsampleBuffer(
        raw,
        inputSampleRate,
        sampleRate
    );
    let pcmEncodedBuffer = audioUtils.pcmEncode(downsampledBuffer);

    // add the right JSON headers and structure to the message
    let audioEventMessage = getAudioEventMessage(Buffer.from(pcmEncodedBuffer));

    //convert the JSON object + headers into a binary event stream message
    let binary = eventStreamMarshaller.marshall(audioEventMessage);
    return binary;
}

function getAudioEventMessage(buffer) {
    // wrap the audio data in a JSON envelope
    return {
        headers: {
            ":message-type": {
                type: "string",
                value: "event",
            },
            ":event-type": {
                type: "string",
                value: "AudioEvent",
            },
        },
        body: buffer,
    };
}

function createPresignedUrl() {
    let endpoint = "transcribestreaming." + region + ".amazonaws.com:8443";

    // get a preauthenticated URL that we can use to establish our WebSocket
    return v4.createPresignedURL(
        "GET",
        endpoint,
        "/stream-transcription-websocket",
        "transcribe",
        crypto.createHash("sha256").update("", "utf8").digest("hex"),
        {
            key: AWS.config.credentials.accessKeyId,
            secret: AWS.config.credentials.secretAccessKey,
            sessionToken: AWS.config.credentials.sessionToken,
            protocol: "wss",
            expires: 15,
            region: region,
            query:
                "language-code=" +
                languageCode +
                "&media-encoding=pcm&sample-rate=" +
                sampleRate,
        }
    );
}

const webcamElement = document.getElementById("webcam");
const canvasElement = document.getElementById("canvas");
const snapSoundElement = document.getElementById("snapSound");
const queryString = window.location.search;

if (queryString != "") {
    var webcam = new Webcam(
        webcamElement,
        "user",
        canvasElement,
        snapSoundElement
    );

    $(".md-modal").addClass("md-show");
    webcam
        .start()
        .then((result) => {
            cameraStarted();
            //console.log("webcam started");
            //console.log(queryString);
        })
        .catch((err) => {
            displayError();
        });
}

$("#cameraFlip").click(function () {
    webcam.flip();
    webcam.start();
});

$("#closeError").click(function () {
    $("#webcam-switch").prop("checked", false).change();
});

function displayError(err = "") {
    if (err != "") {
        $("#errorMsg").html(err);
    }
    $("#errorMsg").removeClass("d-none");
}

function cameraStarted() {
    webcam.flip();
    webcam.start();
    $("#errorMsg").addClass("d-none");
    $(".flash").hide();
    $("#webcam-caption").html("on");
    $("#webcam-control").removeClass("webcam-off");
    $("#webcam-control").addClass("webcam-on");
    $(".webcam-container").removeClass("d-none");
    if (webcam.webcamList.length == 1) {
        $("#cameraFlip").removeClass("d-none");
    }
    $("#wpfront-scroll-top-container").addClass("d-none");
    window.scrollTo(0, 0);
    $("body").css("overflow-y", "hidden");
}

$("#take-photo").click(function () {
    let picture = webcam.snap();
    document.getElementById("cameraFlip").style.display = "none";
    //document.querySelector('#download-photo').href = picture;
    ProcessImage(picture);
});

//Loads selected image and unencodes image bytes for Rekognition API
function ProcessImage(picture) {
    var blob;

    // Load base64 encoded image for display
    var reader = new FileReader();

    reader.onload = (function (theFile) {
        return function (e) {
            //Call Rekognition
            AWS.region = region;
            var rekognition = new AWS.Rekognition();
            var params = {
                Image: {
                    Bytes: e.target.result,
                },
            };

            rekognition.detectText(params, function (err, data) {
                if (err) console.log(err, err.stack);
                // an error occurred
                else {
                    var string = "";
                    for (var i = 0; i < data.TextDetections.length; i++) {
                        if (data.TextDetections[i].Type == "LINE") {
                            string +=
                                data.TextDetections[i].DetectedText + ", ";
                        }
                    }

                    if (string != "") {
                        console.log(string); // successful response
                        
                        var urlParams = new URLSearchParams(queryString);
                        var languageFromURL = urlParams.get("language");
                        //console.log(languageFromURL);

                        document.getElementById("show-text").style.display = "block";
                        document.getElementById("detectedText").innerHTML = string;

                        speakDetectedTextFromWebcam(string, languageFromURL);
                    } else {
                        console.log("No text detected. Please try again!");
                        document.getElementById("show-text").style.display = "block";
                        document.getElementById("detectedText").innerHTML = "No text detected. Please try again!";
                        speakDetectedTextFromWebcam("No text detected. Please try again!", "en-US");
                    }
                }
            });
        };
    })(blob);

    fetch(picture)
        .then((resp) => resp.blob())
        .then((blob) => reader.readAsArrayBuffer(blob));
}