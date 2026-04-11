import sdk, {
  MixinProvider,
  ScryptedDeviceBase,
  ScryptedDeviceType,
  ScryptedInterface,
  WritableDeviceState,
} from '@scrypted/sdk';
import { TalkbackMixin } from './mixin';

class TpLinkTalkbackProvider extends ScryptedDeviceBase implements MixinProvider {

  constructor(nativeId?: string) {
    super(nativeId);
  }

  async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[] | null> {
    if (interfaces.includes(ScryptedInterface.VideoCamera)) {
      return [ScryptedInterface.Intercom, ScryptedInterface.Settings];
    }
    return null;
  }

  async getMixin(
    mixinDevice: any,
    mixinDeviceInterfaces: ScryptedInterface[],
    mixinDeviceState: WritableDeviceState,
  ): Promise<TalkbackMixin> {
    return new TalkbackMixin({
      mixinDevice,
      mixinDeviceInterfaces,
      mixinDeviceState,
      mixinProviderNativeId: undefined,
    });
  }

  async releaseMixin(id: string, mixinDevice: TalkbackMixin): Promise<void> {
    await mixinDevice.release?.();
  }
}

export default new TpLinkTalkbackProvider();
