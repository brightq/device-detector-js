import ClientParser, { ClientResult } from "./parsers/client";
import DeviceParser, { DeviceResult } from "./parsers/device";
import OperatingSystemParser, { Result as OperatingSystemResult } from "./parsers/operating-system";
import VendorFragmentParser from "./parsers/vendor-fragment";
import BrowserParser from "./parsers/client/browser";
import BotParser = require("./parsers/bot");
import get from "lodash/get";
import isBrowser from "./utils/environment-detection";
import { userAgentParser } from "./utils/user-agent";
import { versionCompare } from "./utils/version-compare";
import LRU from "lru-cache";

namespace DeviceDetector { // tslint:disable-line
  export interface DeviceDetectorResult {
    client: ClientResult;
    device: DeviceResult;
    os: OperatingSystemResult;
    bot: BotParser.DeviceDetectorBotResult;
  }

  export interface Options {
    skipBotDetection: boolean;
    versionTruncation: 0 | 1 | 2 | 3 | null;
    cache: boolean | number;
  }
}

class DeviceDetector {
  private readonly cache: LRU.Cache<string, DeviceDetector.DeviceDetectorResult> | undefined;
  private clientParser: ClientParser;
  private deviceParser: DeviceParser;
  private operatingSystemParser: OperatingSystemParser;
  private vendorFragmentParser: VendorFragmentParser;
  private botParser: BotParser;

  // Default options
  private readonly options: DeviceDetector.Options = {
    skipBotDetection: false,
    versionTruncation: 1,
    cache: true
  };

  constructor(options?: Partial<DeviceDetector.Options>) {
    this.options = {...this.options, ...options};
    this.clientParser = new ClientParser(this.options);
    this.deviceParser = new DeviceParser();
    this.operatingSystemParser = new OperatingSystemParser(this.options);
    this.vendorFragmentParser = new VendorFragmentParser();
    this.botParser = new BotParser();

    if (this.options.cache && !isBrowser()) {
      this.cache = LRU<string, DeviceDetector.DeviceDetectorResult>({ maxAge: this.options.cache === true ? Infinity : this.options.cache });
    }
  }

  public parse = (userAgent: string): DeviceDetector.DeviceDetectorResult => {
    if (this.cache) {
      const cachedResult = this.cache.get(userAgent);

      if (cachedResult) {
        return cachedResult;
      }
    }

    const result: DeviceDetector.DeviceDetectorResult = {
      client: this.clientParser.parse(userAgent),
      os: this.operatingSystemParser.parse(userAgent),
      device: this.deviceParser.parse(userAgent),
      bot: this.options.skipBotDetection ? null : this.botParser.parse(userAgent)
    };

    if (!get(result, "device.brand")) {
      const brand = this.vendorFragmentParser.parse(userAgent);

      if (brand) {
        if (!result.device) {
          result.device = this.createDeviceObject();
        }
        result.device.brand = brand;
      }
    }

    const osName = get(result, "os.name");
    const osVersion = get(result, "os.version");
    const osFamily = OperatingSystemParser.getOsFamily(get(result, "os.name"));

    /**
     * Assume all devices running iOS / Mac OS are from Apple
     */
    if (!get(result, "device.brand") && ["Apple TV", "iOS", "Mac"].includes(osName)) {
      if (!result.device) {
        result.device = this.createDeviceObject();
      }

      result.device.brand = "Apple";
    }

    /**
     * Chrome on Android passes the device type based on the keyword 'Mobile'
     * If it is present the device should be a smartphone, otherwise it's a tablet
     * See https://developer.chrome.com/multidevice/user-agent#chrome_for_android_user_agent
     */
    if (!get(result, "device.type") && osFamily === "Android" && ["Chrome", "Chrome Mobile"].includes(get(result, "client.name"))) {
      if (userAgentParser("Chrome/[.0-9]* Mobile", userAgent)) {
        if (!result.device) {
          result.device = this.createDeviceObject();
        }

        result.device.type = "smartphone";
      } else if (userAgentParser("Chrome/[.0-9]* (?!Mobile)", userAgent)) {
        if (!result.device) {
          result.device = this.createDeviceObject();
        }

        result.device.type = "tablet";
      }
    }

    /**
     * Some user agents simply contain the fragment 'Android; Tablet;' or 'Opera Tablet', so we assume those devices are tablets
     */
    if (!get(result, "device.type") && this.hasAndroidTabletFragment(userAgent) || userAgentParser("Opera Tablet", userAgent)) {
      if (!result.device) {
        result.device = this.createDeviceObject();
      }

      result.device.type = "tablet";
    }

    /**
     * Some user agents simply contain the fragment 'Android; Mobile;', so we assume those devices are smartphones
     */
    if (!get(result, "device.type") && this.hasAndroidMobileFragment(userAgent)) {
      if (!result.device) {
        result.device = this.createDeviceObject();
      }

      result.device.type = "smartphone";
    }

    /**
     * Android up to 3.0 was designed for smartphones only. But as 3.0, which was tablet only, was published
     * too late, there were a bunch of tablets running with 2.x
     * With 4.0 the two trees were merged and it is for smartphones and tablets
     *
     * So were are expecting that all devices running Android < 2 are smartphones
     * Devices running Android 3.X are tablets. Device type of Android 2.X and 4.X+ are unknown
     */
    if (!get(result, "device.type") && osName === "Android" && osVersion !== "") {
      if (versionCompare(osVersion, "2.0") === -1) {
        if (!result.device) {
          result.device = this.createDeviceObject();
        }

        result.device.type = "smartphone";
      } else if (versionCompare(osVersion, "3.0") >= 0 && versionCompare(osVersion, "4.0") === -1) {
        if (!result.device) {
          result.device = this.createDeviceObject();
        }

        result.device.type = "tablet";
      }
    }

    /**
     * All detected feature phones running android are more likely smartphones
     */
    if (result.device && get(result, "device.type") === "feature phone" && osFamily === "Android") {
      result.device.type = "smartphone";
    }

    /**
     * According to http://msdn.microsoft.com/en-us/library/ie/hh920767(v=vs.85).aspx
     * Internet Explorer 10 introduces the "Touch" UA string token. If this token is present at the end of the
     * UA string, the computer has touch capability, and is running Windows 8 (or later).
     * This UA string will be transmitted on a touch-enabled system running Windows 8 (RT)
     *
     * As most touch enabled devices are tablets and only a smaller part are desktops/notebooks we assume that
     * all Windows 8 touch devices are tablets.
     */
    if (
      !get(result, "device.type")
      && this.isToucheEnabled(userAgent)
      && (
        osName === "Windows RT"
        || (
          osName === "Windows"
          && versionCompare(osVersion, "8.0") >= 0
        )
      )
    ) {
      if (!result.device) {
        result.device = this.createDeviceObject();
      }

      result.device.type = "tablet";
    }

    /**
     * All devices running Opera TV Store are assumed to be televisions
     */
    if (userAgentParser("Opera TV Store", userAgent)) {
      if (!result.device ) {
        result.device = this.createDeviceObject();
      }

      result.device.type = "television";
    }

    /**
     * Devices running Kylo or Espital TV Browsers are assumed to be televisions
     */
    if (!get(result, "device.type") && ["Kylo", "Espial TV Browser"].includes(get(result, "client.name"))) {
      if (!result.device) {
        result.device = this.createDeviceObject();
      }

      result.device.type = "television";
    }

    // set device type to desktop for all devices running a desktop os that were not detected as an other device type
    if (!get(result, "device.type") && this.isDesktop(result, osFamily)) {
      if (!result.device) {
        result.device = this.createDeviceObject();
      }

      result.device.type = "desktop";
    }

    if (this.cache) {
      this.cache.set(userAgent, result);
    }

    return result;
  };

  private hasAndroidMobileFragment = (userAgent: string) => {
    return userAgentParser("Android( [\.0-9]+)?; Mobile;", userAgent);
  };

  private hasAndroidTabletFragment = (userAgent: string) => {
    return userAgentParser("Android( [\.0-9]+)?; Tablet;", userAgent);
  };

  private isDesktop = (result: DeviceDetector.DeviceDetectorResult, osFamily: string): boolean => {
    if (!result.os) {
      return false;
    }

    // Check for browsers available for mobile devices only
    if (this.usesMobileBrowser(result.client)) {
      return false;
    }

    return OperatingSystemParser.getDesktopOsArray().includes(osFamily);
  };

  private usesMobileBrowser = (client: DeviceDetector.DeviceDetectorResult["client"]) => {
    if (!client) return false;

    return get(client, "type") === "browser" && BrowserParser.isMobileOnlyBrowser(get(client, "name"));
  };

  private isToucheEnabled = (userAgent: string) => {
    return userAgentParser("Touch", userAgent);
  };

  private createDeviceObject = () => ({
    type: "",
    brand: "",
    model: ""
  });
}

export = DeviceDetector;
