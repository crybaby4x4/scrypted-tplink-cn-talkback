import sdk, {
  Intercom,
  MediaObject,
  MixinDeviceOptions,
  ScryptedMimeTypes,
  Setting,
  SettingValue,
} from '@scrypted/sdk';
import { SettingsMixinDeviceBase } from '@scrypted/sdk/settings-mixin';
import { DuplexMode, TalkbackSession, probeCamera } from './talkback';

const { mediaManager } = sdk;

const DEFAULT_PORT = 554;

interface FFmpegInput {
  inputArguments?: string[];
  url?: string;
}

export class TalkbackMixin extends SettingsMixinDeviceBase<any> implements Intercom {
  private talkback: TalkbackSession | undefined;

  constructor(options: MixinDeviceOptions<any>) {
    super({
      ...options,
      group: 'TP-Link Talkback',
      groupKey: 'talkback',
    });
  }

  // Convenience getters — mixin storage keys have NO prefix here;
  // SettingsMixinDeviceBase adds the 'talkback:' prefix in getSettings() output.
  get ip(): string { return this.storage.getItem('ip') ?? ''; }
  get port(): number { return parseInt(this.storage.getItem('port') ?? '') || DEFAULT_PORT; }
  get username(): string { return this.storage.getItem('username') ?? 'admin'; }
  get password(): string { return this.storage.getItem('password') ?? ''; }
  get duplexMode(): DuplexMode {
    const val = this.storage.getItem('duplexMode');
    return val === 'full_duplex' ? 'full_duplex' : 'half_duplex';
  }

  // ── Intercom ─────────────────────────────────────────────────────────────────

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
    this.talkback = new TalkbackSession(
      this.ip, this.port, this.username, this.password, this.duplexMode, this.console,
    );
    await this.talkback.start(inputArgs);
  }

  async stopIntercom(): Promise<void> {
    if (this.talkback) {
      this.talkback.stop();
      this.talkback = undefined;
      this.console.log('[talkback] stopIntercom');
    }
  }

  // ── Settings ─────────────────────────────────────────────────────────────────
  // Keys returned here are WITHOUT the 'talkback:' prefix.
  // SettingsMixinDeviceBase.getSettings() automatically:
  //   • prepends groupKey ('talkback') + ':' to every key
  //   • sets setting.group to this.settingsGroup if unset
  //   • merges results with the underlying device's own settings

  async getMixinSettings(): Promise<Setting[]> {
    return [
      {
        key: 'ip',
        title: 'Camera IP Address',
        description: 'Usually same as the ONVIF IP',
        value: this.ip,
        placeholder: '192.168.1.100',
      },
      {
        key: 'port',
        title: 'RTSP Port',
        description: 'MULTITRANS protocol port (default 554)',
        value: this.port.toString(),
        placeholder: '554',
        type: 'number',
      },
      {
        key: 'username',
        title: 'Username',
        value: this.username,
      },
      {
        key: 'password',
        title: 'Password',
        type: 'password',
      },
      {
        key: 'duplexMode',
        title: 'Duplex Mode',
        description: 'half_duplex: intercom style (default). full_duplex: simultaneous two-way audio',
        value: this.duplexMode,
        choices: ['half_duplex', 'full_duplex'],
      },
      {
        key: 'testConnection',
        title: 'Test Connection',
        description: '点击按钮验证连通性和账号密码，日志输出到控制台',
        type: 'button',
      },
      {
        key: 'testResult',
        title: 'Last Test Result',
        value: this.storage.getItem('testResult') ?? '(not tested yet)',
        readonly: true,
      },
    ];
  }

  // Called by SettingsMixinDeviceBase.putSetting() after stripping the 'talkback:' prefix.
  // Return void/undefined → base class fires onMixinEvent(Settings) automatically.
  async putMixinSetting(key: string, value: SettingValue): Promise<void> {
    if (key === 'testConnection') {
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
    this.storage.setItem(key, value?.toString() ?? '');
  }

  async release(): Promise<void> {
    await this.stopIntercom();
    await super.release();
  }
}
