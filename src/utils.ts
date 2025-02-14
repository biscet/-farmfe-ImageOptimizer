import type { ResolvedConfig } from 'vite';
import type { Options, Sizes } from './types';
import fs from 'fs';
import { dirname, extname, join, basename } from 'pathe';
import ansi from 'ansi-colors';
import { FormatEnum } from 'sharp';
import fsp from 'fs/promises';

function isRegex(src) {
  return Object.prototype.toString.call(src) === '[object RegExp]';
}

function isString(src) {
  return Object.prototype.toString.call(src) === '[object String]';
}

function isArray(src) {
  return Array.isArray(src);
}

export function merge(src, target) {
  const deepClone = (src) => {
    if (typeof src !== 'object' || isRegex(src) || src === null) return src;
    const target = Array.isArray(src) ? [] : {};
    for (const key in src) {
      const value = src[key];
      target[key] = deepClone(value);
    }
    return target;
  };

  const clone = deepClone(src);
  for (const key in target) {
    if (clone[key] === undefined) {
      clone[key] = target[key];
    }
  }
  return clone;
}

export function readAllFiles(root) {
  let resultArr = [];
  try {
    if (fs.existsSync(root)) {
      const stat = fs.lstatSync(root);
      if (stat.isDirectory()) {
        const files = fs.readdirSync(root);
        files.forEach(function (file) {
          const t = readAllFiles(join(root, '/', file));
          resultArr = resultArr.concat(t);
        });
      } else {
        resultArr.push(root);
      }
    }
  } catch (error) {
    console.log(error);
  }

  return resultArr;
}

export function areFilesMatching(fileName: string, matcher): boolean {
  if (isString(matcher)) return fileName === matcher;
  if (isRegex(matcher)) return matcher.test(fileName);
  if (isArray(matcher)) return matcher.includes(fileName);
  return false;
}

function decideStyle(text: string, enableColors: boolean) {
  return enableColors ? text : ansi.unstyle(text);
}

export function logErrors(rootConfig: ResolvedConfig, errorsMap: Map<string, string>, ansiColors: boolean) {
  rootConfig.logger.info(
    decideStyle(`\n🚨 ${ansi.red('[farmfe-image-optimizer]')} - errors during optimization: `, ansiColors),
  );

  const keyLengths: number[] = Array.from(errorsMap.keys(), (name: string) => name.length);
  const maxKeyLength: number = Math.max(...keyLengths);

  errorsMap.forEach((message: string, name: string) => {
    rootConfig.logger.error(
      decideStyle(
        `${ansi.dim(basename(rootConfig.build.outDir))}/${ansi.blueBright(name)}${' '.repeat(
          2 + maxKeyLength - name.length,
        )} ${ansi.red(message)}`,
        ansiColors,
      ),
    );
  });
  rootConfig.logger.info('\n');
}

export function logOptimizationStats(rootConfig: ResolvedConfig, sizesMap: Map<string, Sizes>, ansiColors: boolean) {
  rootConfig.logger.info(
    decideStyle(`\n✨ ${ansi.cyan('[farmfe-image-optimizer]')} - optimized images successfully: `, ansiColors),
  );

  const keyLengths: number[] = Array.from(sizesMap.keys(), (name: string) => name.length);
  const valueLengths: number[] = Array.from(
    sizesMap.values(),
    (value: any) => `${Math.floor(100 * value.ratio)}`.length,
  );

  const maxKeyLength: number = Math.max(...keyLengths);
  const valueKeyLength: number = Math.max(...valueLengths);

  let totalOriginalSize: number = 0;
  let totalSavedSize: number = 0;
  sizesMap.forEach((value, name) => {
    const { size, oldSize, ratio, skipWrite, isCached } = value;

    const percentChange: string = ratio > 0 ? ansi.red(`+${ratio}%`) : ratio <= 0 ? ansi.green(`${ratio}%`) : '';

    const sizeText: string = skipWrite
      ? `${ansi.yellow.bold('skipped')} ${ansi.dim(
          `original: ${oldSize.toFixed(2)} kB <= optimized: ${size.toFixed(2)} kB`,
        )}`
      : isCached
      ? `${ansi.yellow.bold('cached')} ${ansi.dim(`original: ${oldSize.toFixed(2)} kB; cached: ${size.toFixed(2)} kB`)}`
      : ansi.dim(`${oldSize.toFixed(2)} kB ⭢  ${size.toFixed(2)} kB`);

    rootConfig.logger.info(
      decideStyle(
        ansi.dim(basename(rootConfig.build.outDir)) +
          '/' +
          ansi.blueBright(name) +
          ' '.repeat(2 + maxKeyLength - name.length) +
          ansi.gray(`${percentChange} ${' '.repeat(valueKeyLength - `${ratio}`.length)}`) +
          ' ' +
          sizeText,
        ansiColors,
      ),
    );

    if (!skipWrite) {
      totalOriginalSize += oldSize;
      totalSavedSize += oldSize - size;
    }
  });

  if (totalSavedSize > 0) {
    const savedText = `${totalSavedSize.toFixed(2)}kB`;
    const originalText = `${totalOriginalSize.toFixed(2)}kB`;
    const savingsPercent = `${Math.round((totalSavedSize / totalOriginalSize) * 100)}%`;
    rootConfig.logger.info(
      decideStyle(
        `\n💰 total savings = ${ansi.green(savedText)}/${ansi.green(originalText)} ≈ ${ansi.green(savingsPercent)}`,
        ansiColors,
      ),
    );
  }

  rootConfig.logger.info('\n');
}

export const applySharp = async (filePath: string, buffer: Buffer, options: Options): Promise<Buffer> => {
  const sharp = (await import('sharp')).default;
  const extName: string = extname(filePath).replace('.', '').toLowerCase();
  return await sharp(buffer, { animated: extName === 'gif' })
    .toFormat(extName as keyof FormatEnum, options[extName])
    .metadata(() => {
      return undefined;
    })
    .toBuffer();
};

export const processFile = async (
  filePath: string,
  buffer: Buffer,
  options: Options,
  sizesMap: Map<string, any>,
  errorsMap: Map<string, string>,
) => {
  try {
    let newBuffer: Buffer;

    let isCached: boolean;
    const cachedFilePath = join(options.cacheLocation, filePath);
    if (options.cache === true && fs.existsSync(cachedFilePath)) {
      newBuffer = await fsp.readFile(cachedFilePath);
      isCached = true;
    } else {
      const engine = applySharp;
      newBuffer = await engine(filePath, buffer, options);
      isCached = false;
    }

    if (options.cache === true && !isCached) {
      if (!fs.existsSync(dirname(cachedFilePath))) {
        await fsp.mkdir(dirname(cachedFilePath), { recursive: true });
      }
      await fsp.writeFile(cachedFilePath, newBuffer);
    }

    const newSize: number = newBuffer.byteLength;
    const oldSize: number = buffer.byteLength;
    const skipWrite: boolean = newSize >= oldSize;

    sizesMap.set(filePath, {
      size: newSize / 1024,
      oldSize: oldSize / 1024,
      ratio: Math.floor(100 * (newSize / oldSize - 1)),
      skipWrite,
      isCached,
    });

    return { content: newBuffer, skipWrite };
  } catch (error) {
    errorsMap.set(filePath, error.message);
    return {};
  }
};

export const getFilesToProcess = (allFiles: string[], getFileName: Function, options: Options) => {
  if (options.include) {
    return allFiles.reduce((acc, filePath) => {
      const fileName: string = getFileName(filePath);
      if (areFilesMatching(fileName, options.include)) {
        acc.push(filePath);
      }
      return acc;
    }, []);
  }

  return allFiles.reduce((acc, filePath) => {
    if (options.test?.test(filePath)) {
      const fileName: string = getFileName(filePath);
      if (!areFilesMatching(fileName, options.exclude)) {
        acc.push(filePath);
      }
    }
    return acc;
  }, []);
};

export const ensureCacheDirectoryExists = async (options: Options) => {
  if (options.cache === true && !fs.existsSync(options.cacheLocation)) {
    await fsp.mkdir(options.cacheLocation, { recursive: true });
  }
};
