import sdk, {
  MixinProvider,
  ScryptedDeviceType,
  ScryptedInterface,
  WritableDeviceState,
} from '@scrypted/sdk';
import { TalkbackMixin } from './mixin';

class TpLinkTalkbackProvider implements MixinProvider {

  // Called by Scrypted to check if this mixin can apply to a device.
  // Return the list of interfaces to add, or null if not applicable.
  async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[] | null> {
    // Apply to any device that has a video stream (cameras, doorbells, etc.)
    if (interfaces.includes(ScryptedInterface.VideoCamera)) {
      return [
        ScryptedInterface.Intercom,
        ScryptedInterface.Settings,
      ];
    }
    return null;
  }

  // Called when the mixin is enabled on a device.
  async getMixin(
    mixinDevice: any,
    mixinDeviceInterfaces: ScryptedInterface[],
    mixinDeviceState: WritableDeviceState,
  ): Promise<TalkbackMixin> {
    return new TalkbackMixin(
      mixinDevice,
      mixinDeviceInterfaces,
      mixinDeviceState,
      undefined,
    );
  }

  // Called when the mixin is disabled or the device is removed.
  async releaseMixin(id: string, mixinDevice: TalkbackMixin): Promise<void> {
    await mixinDevice.release?.();
  }
}

export default new TpLinkTalkbackProvider();
