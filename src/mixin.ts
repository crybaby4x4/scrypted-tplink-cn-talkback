import sdk, {
  Intercom,
  MediaObject,
  MixinDeviceBase,
  ScryptedDeviceType,
  ScryptedInterface,
  ScryptedMimeTypes,
  Setting,
  SettingValue,
  WritableDeviceState,
} from '@scrypted/sdk';
import { TalkbackSession } from './talkback';

const { mediaManager } = sdk;

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
  get username(): string { return this.storage.getItem('username') ?? 'admin'; }
  get password(): string { return this.storage.getItem('password') ?? ''; }

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

    this.console.log('[talkback] startIntercom, target:', this.ip);
    this.talkback = new TalkbackSession(this.ip, this.username, this.password, this.console);
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
    // Get original device settings (ONVIF config etc.)
    const deviceSettings: Setting[] = await this.mixinDevice.getSettings?.() ?? [];

    // Append our talkback settings as a separate group
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
        value: this.password,
      },
    ];

    return [...deviceSettings, ...talkbackSettings];
  }

  async putSetting(key: string, value: SettingValue): Promise<void> {
    // Keys prefixed with 'talkback:' belong to us
    if (key.startsWith('talkback:')) {
      this.storage.setItem(key.slice('talkback:'.length), value?.toString() ?? '');
    } else {
      // Forward to underlying device
      await this.mixinDevice.putSetting?.(key, value);
    }
  }

  async release(): Promise<void> {
    await this.stopIntercom();
  }
}
