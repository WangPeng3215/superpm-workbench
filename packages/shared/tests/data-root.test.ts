import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DataRootConfigError,
  assertDataRootAvailable,
  defaultDataHome,
  expectedDatabasePath,
  readDataRootConfig,
  readHomeMarker,
  readMovedMarker,
  resolveConfigDir,
  resolveDataRoot,
  writeDataRootConfig,
  writeHomeMarker,
  writeMovedMarker,
} from "@superpm/shared/data-root";

const directories: string[] = [];

function tempDir(prefix = "superpm-root-") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
  directories.length = 0;
});

function writeConfig(directory: string, value: unknown) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "config.json"),
    typeof value === "string" ? value : JSON.stringify(value),
    "utf8",
  );
}

function validConfig(home: string) {
  return {
    schemaVersion: 1,
    home,
    updatedAt: "2026-10-24T08:30:00.000Z",
  };
}

describe("配置目录与默认数据根", () => {
  it("按平台解析配置目录并支持 SUPERPM_CONFIG_DIR 覆盖", () => {
    expect(
      resolveConfigDir(
        { APPDATA: "C:\\Users\\demo\\AppData\\Roaming" },
        "win32",
      ),
    ).toBe(join("C:\\Users\\demo\\AppData\\Roaming", "superPM"));
    expect(
      resolveConfigDir({ XDG_CONFIG_HOME: "/home/demo/.config" }, "linux"),
    ).toBe(join("/home/demo/.config", "superpm"));
    expect(resolveConfigDir({}, "darwin")).toBe(
      join(homedir(), "Library", "Application Support", "superPM"),
    );
    const override = tempDir();
    expect(resolveConfigDir({ SUPERPM_CONFIG_DIR: override }, "linux")).toBe(
      override,
    );
  });

  it("按平台解析默认数据根", () => {
    expect(
      defaultDataHome(
        { LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local" },
        "win32",
      ),
    ).toBe(join("C:\\Users\\demo\\AppData\\Local", "superPM"));
    expect(defaultDataHome({ XDG_DATA_HOME: "/data/demo" }, "linux")).toBe(
      join("/data/demo", "superpm"),
    );
    expect(defaultDataHome({}, "darwin")).toBe(
      join(homedir(), "Library", "Application Support", "superPM"),
    );
  });
});

describe("数据根解析优先级", () => {
  it("发布包未设置 SUPERPM_HOME 时读取配置指针", () => {
    const configDir = tempDir();
    const home = tempDir("superpm-home-");
    writeConfig(configDir, validConfig(home));
    const resolution = resolveDataRoot({
      env: { SUPERPM_CONFIG_DIR: configDir },
      packaged: true,
      developmentRoot: tempDir("superpm-dev-"),
    });
    expect(resolution).toMatchObject({
      home,
      source: "config",
      configDir,
      configPath: join(configDir, "config.json"),
      markerPath: join(home, ".superpm-home.json"),
    });
  });

  it("环境变量优先于配置指针", () => {
    const configDir = tempDir();
    const envHome = tempDir("superpm-env-");
    writeConfig(configDir, validConfig(tempDir("superpm-config-")));
    const resolution = resolveDataRoot({
      env: { SUPERPM_CONFIG_DIR: configDir, SUPERPM_HOME: envHome },
      packaged: true,
      developmentRoot: tempDir("superpm-dev-"),
    });
    expect(resolution.home).toBe(envHome);
    expect(resolution.source).toBe("env");
  });

  it("启动器来源标记为 config 时校验指针一致", () => {
    const configDir = tempDir();
    const home = tempDir("superpm-home-");
    writeConfig(configDir, validConfig(home));
    const resolution = resolveDataRoot({
      env: {
        SUPERPM_CONFIG_DIR: configDir,
        SUPERPM_HOME: home,
        SUPERPM_HOME_SOURCE: "config",
      },
      packaged: true,
      developmentRoot: tempDir("superpm-dev-"),
    });
    expect(resolution.source).toBe("config");

    const other = tempDir("superpm-other-");
    writeConfig(configDir, validConfig(other));
    expect(() =>
      resolveDataRoot({
        env: {
          SUPERPM_CONFIG_DIR: configDir,
          SUPERPM_HOME: home,
          SUPERPM_HOME_SOURCE: "config",
        },
        packaged: true,
        developmentRoot: tempDir("superpm-dev-"),
      }),
    ).toThrow(/不一致/);
  });

  it("开发仓库未设置 SUPERPM_HOME 时忽略配置指针", () => {
    const configDir = tempDir();
    const developmentRoot = tempDir("superpm-dev-");
    writeConfig(configDir, validConfig(tempDir("superpm-config-")));
    const resolution = resolveDataRoot({
      env: { SUPERPM_CONFIG_DIR: configDir },
      packaged: false,
      developmentRoot,
    });
    expect(resolution.home).toBe(developmentRoot);
    expect(resolution.source).toBe("development");
  });

  it("配置缺失时回退平台默认目录", () => {
    const configDir = tempDir();
    const localAppData = tempDir("superpm-local-");
    const resolution = resolveDataRoot({
      env: { SUPERPM_CONFIG_DIR: configDir, LOCALAPPDATA: localAppData },
      packaged: true,
      developmentRoot: tempDir("superpm-dev-"),
      platform: "win32",
    });
    expect(resolution.home).toBe(join(localAppData, "superPM"));
    expect(resolution.source).toBe("default");
  });

  it("网络路径返回保持连接的警告", () => {
    const resolution = resolveDataRoot({
      env: {
        SUPERPM_HOME: "\\\\nas\\share\\superPM",
        SUPERPM_CONFIG_DIR: tempDir(),
      },
      packaged: true,
      developmentRoot: tempDir("superpm-dev-"),
      platform: "win32",
    });
    expect(resolution.warning).toMatch(/网络路径/);
  });
});

describe("配置指针读写", () => {
  it("主配置损坏时回退 config.json.bak", () => {
    const configDir = tempDir();
    const home = tempDir("superpm-home-");
    writeConfig(configDir, "{ not json");
    writeFileSync(
      join(configDir, "config.json.bak"),
      JSON.stringify(validConfig(home)),
      "utf8",
    );
    const resolution = resolveDataRoot({
      env: { SUPERPM_CONFIG_DIR: configDir },
      packaged: true,
      developmentRoot: tempDir("superpm-dev-"),
    });
    expect(resolution.home).toBe(home);
    expect(resolution.warning).toMatch(/备份/);
  });

  it("配置版本过高时回退备份，两者都不可用时明确报错", () => {
    const configDir = tempDir();
    const home = tempDir("superpm-home-");
    writeConfig(configDir, { schemaVersion: 2, home });
    writeFileSync(
      join(configDir, "config.json.bak"),
      JSON.stringify(validConfig(home)),
      "utf8",
    );
    const resolution = resolveDataRoot({
      env: { SUPERPM_CONFIG_DIR: configDir },
      packaged: true,
      developmentRoot: tempDir("superpm-dev-"),
    });
    expect(resolution.home).toBe(home);
    expect(resolution.warning).toMatch(/备份/);

    writeFileSync(join(configDir, "config.json.bak"), "{ broken", "utf8");
    expect(() =>
      resolveDataRoot({
        env: { SUPERPM_CONFIG_DIR: configDir },
        packaged: true,
        developmentRoot: tempDir("superpm-dev-"),
      }),
    ).toThrow(/配置文件不可用/);
  });

  it("写入配置时保留旧文件为 .bak 并原子落盘", () => {
    const configDir = tempDir();
    const first = validConfig(tempDir("superpm-first-"));
    writeDataRootConfig(first, { configDir });
    const second = validConfig(tempDir("superpm-second-"));
    const path = writeDataRootConfig(second, { configDir });

    expect(path).toBe(join(configDir, "config.json"));
    expect(JSON.parse(readFileSync(`${path}.bak`, "utf8"))).toEqual(first);
    expect(readDataRootConfig({ configDir })?.config).toEqual(second);
    expect(readdirSync(configDir).some((file) => file.includes(".tmp-"))).toBe(
      false,
    );
  });

  it("拒绝非绝对路径的配置指针", () => {
    expect(() =>
      writeDataRootConfig(
        { schemaVersion: 1, home: "relative/superPM" },
        { configDir: tempDir() },
      ),
    ).toThrow(DataRootConfigError);
  });
});

describe("启动保护", () => {
  function configResolution(home: string) {
    const configDir = tempDir();
    writeConfig(configDir, validConfig(home));
    return resolveDataRoot({
      env: { SUPERPM_CONFIG_DIR: configDir },
      packaged: true,
      developmentRoot: tempDir("superpm-dev-"),
    });
  }

  it("配置数据根不存在时拒绝启动", () => {
    const home = join(tempDir("superpm-missing-"), "not-mounted");
    expect(() => assertDataRootAvailable(configResolution(home))).toThrow(
      /数据根不可用/,
    );
  });

  it("空目录没有数据库或标记时拒绝启动", () => {
    const home = tempDir("superpm-empty-");
    try {
      assertDataRootAvailable(configResolution(home));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DataRootConfigError);
      expect((error as DataRootConfigError).code).toBe("CONFIG_HOME_EMPTY");
    }
  });

  it("发现数据库或数据根标记时允许启动", () => {
    const withDatabase = tempDir("superpm-db-");
    mkdirSync(join(withDatabase, "data"), { recursive: true });
    writeFileSync(join(withDatabase, "data", "superpm.sqlite"), "");
    expect(() =>
      assertDataRootAvailable(configResolution(withDatabase)),
    ).not.toThrow();

    const withMarker = tempDir("superpm-marker-");
    writeHomeMarker(withMarker, {
      schemaVersion: 1,
      home: withMarker,
    });
    expect(() =>
      assertDataRootAvailable(configResolution(withMarker)),
    ).not.toThrow();
  });

  it("默认来源不要求标记即可创建", () => {
    const home = join(tempDir("superpm-default-"), "new");
    expect(() =>
      assertDataRootAvailable({
        home,
        source: "default",
        configDir: tempDir(),
        configPath: join(tempDir(), "config.json"),
        markerPath: join(home, ".superpm-home.json"),
      }),
    ).not.toThrow();
  });

  it("expectedDatabasePath 尊重相对数据目录设置", () => {
    const home = tempDir("superpm-data-");
    expect(expectedDatabasePath(home, { SUPERPM_DATA_DIR: "store" })).toBe(
      join(home, "store", "superpm.sqlite"),
    );
  });
});

describe("数据根标记", () => {
  it("写入并读取数据根标记与旧目录标记", () => {
    const home = tempDir("superpm-marker-");
    writeHomeMarker(home, {
      schemaVersion: 1,
      home,
      movedFrom: "C:\\old",
      jobId: "job-1",
      createdAt: "2026-10-24T08:30:00.000Z",
    });
    expect(readHomeMarker(home)).toMatchObject({ home, jobId: "job-1" });

    const oldHome = tempDir("superpm-old-");
    writeMovedMarker(oldHome, {
      schemaVersion: 1,
      to: home,
      jobId: "job-1",
      movedAt: "2026-10-24T08:31:00.000Z",
    });
    expect(readMovedMarker(oldHome)).toMatchObject({
      to: home,
      jobId: "job-1",
    });
  });

  it("损坏的标记返回 null", () => {
    const home = tempDir("superpm-marker-");
    writeFileSync(join(home, ".superpm-home.json"), "{ broken", "utf8");
    expect(readHomeMarker(home)).toBeNull();
  });
});
