import sdk, {
  Intercom,
  MediaObject,
  MixinDeviceBase,
  ScryptedInterface,
  ScryptedMimeTypes,
  Setting,
  SettingValue,
  WritableDeviceState,
} from '@scrypted/sdk';
import { DuplexMode, TalkbackSession, probeCamera } from './talkback';

const { mediaManager } = sdk;

const DEFAULT_PORT = 554;

interface FFmpegInput {
  inputArguments?: string[];
  url?: string;
}

export class TalkbackMixin extends MixinDeviceBase<any> implements Intercom {
  private talkback: TalkbackSession | undefined;

  constructor(
    mixinDevice: any,
    mixinDeviceInterfaces: ScryptedInterface[],
    mixinDeviceState: WritableDeviceState,
    mixinProviderNativeId: string | undefined,
  ) {
    super({ mixinDevice, mixinDeviceInterfaces, mixinDeviceState, mixinProviderNativeId });
  }

  // Settings stored in mixin's own storage (separate from ONVIF device storage)
  get ip(): string { return this.storage.getItem('ip') ?? ''; }
  get port(): number { return parseInt(this.storage.getItem('port') ?? '') || DEFAULT_PORT; }
  get username(): string { return this.storage.getItem('username') ?? 'admin'; }
  get password(): string { return this.storage.getItem('password') ?? ''; }
  get duplexMode(): DuplexMode {
    const val = this.storage.getItem('duplexMode');
    return val === 'full_duplex' ? 'full_duplex' : 'half_duplex';
  }

  // Intercom interface
  async startIntercom(media: MediaObject): Promise<void> {
    await this.stopIntercom();

    if (!this.ip) throw new Error('TP-Link Talkback: IP address not configured');

    const ffmpegInput = await mediaManager.convertMediaObjectToJSON<FFmpegInput>(
      media,
      ScryptedMimeTypes.FFmpegInput,
    );

    const inputArgs = ffmpegInput.inputArguments ?? (ffmpegInput.url ? ['-i', ffmpegInput.url] : []);
    if (!inputArgs.length) throw new Error('No FFmpeg input arguments from media object');

    this.console.log('[talkback] startIntercom, target:', `${this.ip}:${this.port}`);
    this.talkback = new TalkbackSession(this.ip, this.port, this.username, this.password, this.duplexMode, this.console);
    await this.talkback.start(inputArgs);
  }

  async stopIntercom(): Promise<void> {
    if (this.talkback) {
      this.talkback.stop();
      this.talkback = undefined;
      this.console.log('[talkback] stopIntercom');
    }
  }

  // Settings: proxy underlying device settings + append our own
  async getSettings(): Promise<Setting[]> {
    const deviceSettings: Setting[] = await this.mixinDevice.getSettings?.() ?? [];

    const talkbackSettings: Setting[] = [
      {
        key: 'talkback:ip',
        group: 'TP-Link Talkback',
        title: 'Camera IP Address',
        description: 'Usually same as the ONVIF IP',
        value: this.ip,
        placeholder: '192.168.1.100',
      },
      {
        key: 'talkback:port',
        group: 'TP-Link Talkback',
        title: 'RTSP Port',
        description: 'MULTITRANS protocol port (default 554)',
        value: this.port.toString(),
        placeholder: '554',
        type: 'number',
      },
      {
        key: 'talkback:username',
        group: 'TP-Link Talkback',
        title: 'Username',
        value: this.username,
      },
      {
        key: 'talkback:password',
        group: 'TP-Link Talkback',
        title: 'Password',
        type: 'password',
      },
      {
        key: 'talkback:duplexMode',
        group: 'TP-Link Talkback',
        title: 'Duplex Mode',
        description: 'half_duplex: intercom style (default). full_duplex: simultaneous two-way audio',
        value: this.duplexMode,
        choices: ['half_duplex', 'full_duplex'],
      },
      {
        key: 'talkback:testConnection',
        group: 'TP-Link Talkback',
        title: 'Test Connection',
        description: '点击以验证摄像头连通性和账号密码是否正确，结果输出到控制台日志',
        type: 'button',
      } as Setting,
      {
        key: 'talkback:testResult',
        group: 'TP-Link Talkback',
        title: 'Last Test Result',
        value: this.storage.getItem('testResult') ?? '(not tested yet)',
        readonly: true,
      } as Setting,
    ];

    return [...deviceSettings, ...talkbackSettings];
  }

  async putSetting(key: string, value: SettingValue): Promise<void> {
    if (key.startsWith('talkback:')) {
      const subkey = key.slice('talkback:'.length);

      if (subkey === 'testConnection') {
        if (!this.ip) {
          this.storage.setItem('testResult', '✗ 未配置摄像头 IP');
          return;
        }
        this.console.log('[talkback] 开始测试连接…');
        const result = await probeCamera(this.ip, this.port, this.username, this.password, this.console);
        this.console.log('[talkback] 测试结果：', result);
        this.storage.setItem('testResult', result);
        return;
      }

      this.storage.setItem(subkey, value?.toString() ?? '');
    } else {
      await this.mixinDevice.putSetting?.(key, value);
    }
  }

  async release(): Promise<void> {
    await this.stopIntercom();
  }
}
