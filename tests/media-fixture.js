export const fakeMediaScript = () => {
  const audioContexts = [];
  const activeTimers = [];

  window.__screenRecorderTestState = {
    displayCalls: 0,
    userMediaCalls: [],
  };

  const fakeDevices = [
    {
      kind: "audioinput",
      deviceId: "mic-default",
      label: "MacBook Microphone",
    },
    { kind: "audioinput", deviceId: "mic-studio", label: "Studio Microphone" },
    {
      kind: "videoinput",
      deviceId: "camera-default",
      label: "FaceTime Camera",
    },
    { kind: "videoinput", deviceId: "camera-brio", label: "External Camera" },
  ];

  function createAudioTrack() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;

    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    gain.gain.value = 0.02;
    oscillator.frequency.value = 220;
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();
    audioContexts.push(context);
    return destination.stream.getAudioTracks()[0] || null;
  }

  function createCanvasStream({ width, height, label, withAudio = false }) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    let frame = 0;

    function draw() {
      frame += 1;
      ctx.fillStyle = label === "Camera" ? "#1f2937" : "#0f172a";
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = label === "Camera" ? "#2dd4bf" : "#f97316";
      ctx.fillRect(
        (frame * 7) % width,
        height * 0.25,
        width * 0.18,
        height * 0.28,
      );
      ctx.fillStyle = "#ffffff";
      ctx.font = `${Math.round(height / 12)}px system-ui, sans-serif`;
      ctx.fillText(label, Math.round(width * 0.06), Math.round(height * 0.18));
    }

    draw();
    const timer = window.setInterval(draw, 33);
    activeTimers.push(timer);

    const stream = canvas.captureStream(30);
    if (withAudio) {
      const audioTrack = createAudioTrack();
      if (audioTrack) stream.addTrack(audioTrack);
    }

    const stopTracks = stream.getTracks().map((track) => {
      const stop = track.stop.bind(track);
      track.stop = () => {
        window.clearInterval(timer);
        stop();
      };
      return track;
    });
    void stopTracks;
    return stream;
  }

  const mediaDevices = window.navigator.mediaDevices || {};
  Object.defineProperty(window.navigator, "mediaDevices", {
    configurable: true,
    value: mediaDevices,
  });

  mediaDevices.getDisplayMedia = async (constraints = {}) => {
    window.__screenRecorderTestState.displayCalls += 1;
    return createCanvasStream({
      width: 1280,
      height: 720,
      label: "Display",
      withAudio: Boolean(constraints.audio),
    });
  };

  mediaDevices.enumerateDevices = async () => fakeDevices;

  mediaDevices.getUserMedia = async (constraints = {}) => {
    window.__screenRecorderTestState.userMediaCalls.push(constraints);
    const tracks = [];
    if (constraints.video) {
      tracks.push(
        ...createCanvasStream({
          width: 640,
          height: 400,
          label: "Camera",
        }).getVideoTracks(),
      );
    }
    if (constraints.audio) {
      const audioTrack = createAudioTrack();
      if (audioTrack) tracks.push(audioTrack);
    }
    return new MediaStream(tracks);
  };

  window.addEventListener("beforeunload", () => {
    for (const timer of activeTimers) window.clearInterval(timer);
    for (const context of audioContexts) context.close();
  });
};
