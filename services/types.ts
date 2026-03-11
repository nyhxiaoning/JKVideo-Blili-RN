export interface VideoItem {
  bvid: string;
  aid: number;
  title: string;
  pic: string;
  owner: {
    mid: number;
    name: string;
    face: string;
  };
  stat?: {
    view: number;
    danmaku: number;
    reply: number;
    like: number;
    coin: number;
    favorite: number;
  } | null;
  duration: number;
  desc: string;
  cid?: number;
  pages?: Array<{ cid: number; part: string }>;
}

export interface Comment {
  rpid: number;
  content: { message: string };
  member: {
    uname: string;
    avatar: string;
  };
  like: number;
  ctime: number;
  replies: Comment[] | null;
}

export interface DashSegmentBase {
  initialization: string;
  index_range: string;
}

export interface DashVideoItem {
  id: number;
  baseUrl: string;
  bandwidth: number;
  mimeType: string;
  codecs: string;
  width: number;
  height: number;
  stat:any;
  frameRate: string;
  segment_base?: DashSegmentBase;
}

export interface DashAudioItem {
  id: number;
  baseUrl: string;
  bandwidth: number;
  mimeType: string;
  codecs: string;
  segment_base?: DashSegmentBase;
}

export interface PlayUrlResponse {
  durl?: Array<{
    url: string;
    length: number;
    size: number;
  }>;
  dash?: {
    duration: number;
    video: DashVideoItem[];
    audio: DashAudioItem[];
  };
  quality: number;
  accept_quality: number[];
  accept_description: string[];
}

export interface QRCodeInfo {
  url: string;
  qrcode_key: string;
}

export interface VideoShotData {
  img_x_len: number;
  img_y_len: number;
  img_x_size: number;
  img_y_size: number;
  image: string[];
  pvdata?: string; // base64 protobuf: packed float32 timestamps (seconds) per frame
}

export interface HeatmapResponse {
  timestamp: number;
  pb_data: string;
}
