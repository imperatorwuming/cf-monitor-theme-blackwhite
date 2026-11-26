import { nativeAsset } from "@/services/cfTransport";
import { useEffect, useState } from "react";

interface OsConfig {
  name: string;
  image: string;
  keywords: string[];
}

const OS_NAME_SPLIT_REGEX = /[\s/]+/;

const OS_CONFIGS: OsConfig[] = [
  {
    name: "AlmaLinux",
    image: "/os-icons/os-alma.svg",
    keywords: ["alma", "almalinux"],
  },
  {
    name: "Alpine Linux",
    image: "/os-icons/os-alpine.webp",
    keywords: ["alpine", "alpine linux"],
  },
  {
    name: "Armbian",
    image: "/os-icons/os-armbian.png",
    keywords: ["armbian"],
  },
  {
    name: "CentOS",
    image: "/os-icons/os-centos.svg",
    keywords: ["centos", "cent os"],
  },
  {
    name: "Debian",
    image: "/os-icons/os-debian.svg",
    keywords: ["debian", "deb"],
  },
  {
    name: "FreeBSD",
    image: "/os-icons/os-freebsd.svg",
    keywords: ["freebsd", "bsd"],
  },
  {
    name: "Ubuntu",
    image: "/os-icons/os-ubuntu.svg",
    keywords: ["ubuntu", "elementary"],
  },
  {
    name: "Windows",
    image: "/os-icons/os-windows.svg",
    keywords: ["windows", "win", "microsoft", "ms"],
  },
  {
    name: "Arch Linux",
    image: "/os-icons/os-arch.svg",
    keywords: ["arch", "archlinux", "arch linux"],
  },
  {
    name: "Kali Linux",
    image: "/os-icons/os-kail.svg",
    keywords: ["kail", "kali", "kali linux"],
  },
  {
    name: "iStoreOS",
    image: "/os-icons/os-istore.png",
    keywords: ["istore", "istoreos", "istore os"],
  },
  {
    name: "OpenWrt",
    image: "/os-icons/os-openwrt.svg",
    keywords: ["openwrt", "open wrt", "open-wrt", "qwrt"],
  },
  {
    name: "ImmortalWrt",
    image: "/os-icons/os-openwrt.svg",
    keywords: ["immortalwrt", "immortal", "emmortal"],
  },
  {
    name: "NixOS",
    image: "/os-icons/os-nix.svg",
    keywords: ["nixos", "nix os", "nix"],
  },
  {
    name: "Rocky Linux",
    image: "/os-icons/os-rocky.svg",
    keywords: ["rocky", "rocky linux"],
  },
  {
    name: "Fedora",
    image: "/os-icons/os-fedora.svg",
    keywords: ["fedora"],
  },
  {
    name: "openSUSE",
    image: "/os-icons/os-openSUSE.svg",
    keywords: ["opensuse", "suse"],
  },
  {
    name: "Gentoo",
    image: "/os-icons/os-gentoo.svg",
    keywords: ["gentoo"],
  },
  {
    name: "Red Hat",
    image: "/os-icons/os-redhat.svg",
    keywords: ["redhat", "rhel", "red hat"],
  },
  {
    name: "Linux Mint",
    image: "/os-icons/os-mint.svg",
    keywords: ["mint", "linux mint"],
  },
  {
    name: "Manjaro",
    image: "/os-icons/os-manjaro-.svg",
    keywords: ["manjaro"],
  },
  {
    name: "Synology DSM",
    image: "/os-icons/os-synology.ico",
    keywords: ["synology", "dsm", "synology dsm"],
  },
  {
    name: "fnOS",
    image: "/os-icons/os-fnos.ico",
    keywords: ["fnos", "fnnas"],
  },
  {
    name: "Proxmox VE",
    image: "/os-icons/os-proxmox.ico",
    keywords: ["proxmox", "proxmox ve"],
  },
  {
    name: "macOS",
    image: "/os-icons/os-macos.svg",
    keywords: ["macos", "mac os", "mac os x", "osx", "darwin"],
  },
  {
    name: "QTS",
    image: "/os-icons/os-qnap.svg",
    keywords: ["qts", "quts hero", "qes", "qutscloud"],
  },
  {
    name: "Astra Linux",
    image: "/os-icons/os-astar.png",
    keywords: ["astra", "astra linux"],
  },
  {
    name: "Orange Pi",
    image: "/os-icons/os-orange-pi.svg",
    keywords: ["orange pi", "orangepi"],
  },
  {
    name: "Huawei",
    image: "/os-icons/os-huawei.svg",
    keywords: ["huawei", "euleros", "euler os"],
  },
  {
    name: "Aliyun",
    image: "/os-icons/os-alibaba.svg",
    keywords: ["aliyun", "alibaba"],
  },
  {
    name: "OpenCloudOS",
    image: "/os-icons/os-opencloud.svg",
    keywords: ["opencloud"],
  },
  {
    name: "Unraid",
    image: "/os-icons/os-unraid.svg",
    keywords: ["unraid"],
  },
];

const DEFAULT_OS_CONFIG: OsConfig = {
  name: "Linux",
  image: "/os-icons/os-unknown.svg",
  keywords: ["unknown"],
};

// 按单词边界匹配关键词,而不是裸子串。子串匹配会严重误判:"darwin"(macOS uname)含 "win"→Windows、
// "unix" 含 "nix"→NixOS 等。每个 OS 预编译一个 \b 锚定的 alternation 既能避免误判,又支持 "red hat" 这种多词关键词。
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const OS_MATCHERS = OS_CONFIGS.map((config) => ({
  config,
  matcher: new RegExp(`\\b(?:${config.keywords.map(escapeRegExp).join("|")})\\b`),
}));

function findOsConfig(osString?: string | null): OsConfig {
  if (!osString) {
    return DEFAULT_OS_CONFIG;
  }

  const normalizedInput = osString.toLowerCase().trim();
  for (const { config, matcher } of OS_MATCHERS) {
    if (matcher.test(normalizedInput)) {
      return config;
    }
  }

  return DEFAULT_OS_CONFIG;
}

export function resolveOsInfo(value?: string | null) {
  const config = findOsConfig(value);
  if (config !== DEFAULT_OS_CONFIG) {
    return config;
  }

  const name = value?.trim().split(OS_NAME_SPLIT_REGEX)[0] || DEFAULT_OS_CONFIG.name;
  return {
    ...DEFAULT_OS_CONFIG,
    name,
  };
}

export function OsLogo({
  value,
  size = 18,
}: {
  value?: string | null;
  size?: number;
}) {
  const os = resolveOsInfo(value);
  // 某个 OS logo 文件缺失时回退到默认 Linux logo,这样冷门或拼错的 OS 字符串也能显示真图标而不是裂图
  const [errored, setErrored] = useState(false);
  useEffect(() => {
    setErrored(false);
  }, [os.image]);
  const src = errored ? DEFAULT_OS_CONFIG.image : os.image;

  return (
    <img
      className="os-logo"
      src={nativeAsset(src)}
      alt={os.name}
      title={os.name}
      width={size}
      height={size}
      loading="lazy"
      draggable={false}
      onError={() => {
        if (!errored) setErrored(true);
      }}
      style={{ "--os-logo-size": `${size}px` } as React.CSSProperties}
    />
  );
}
