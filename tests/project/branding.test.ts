import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const readProjectFile = (path: string) =>
  readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('WeChatPilot public identity', () => {
  it('uses the new public brand without renaming the deployed LaunchAgent', async () => {
    const [readme, packageText, issueConfig, launchd] = await Promise.all([
      readProjectFile('README.md'),
      readProjectFile('package.json'),
      readProjectFile('.github/ISSUE_TEMPLATE/config.yml'),
      readProjectFile('launchd/com.kdnsna.daily-tech-digest.plist'),
    ]);
    const packageJson = JSON.parse(packageText) as Record<string, unknown>;

    expect(readme).toContain('# WeChatPilot');
    expect(readme).toContain('Local-first AI automation for WeChat');
    expect(readme).toContain('非微信或腾讯官方项目');
    expect(packageJson.name).toBe('wechatpilot');
    expect(packageJson.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/kdnsna/WeChatPilot.git',
    });
    expect(issueConfig).toContain('github.com/kdnsna/WeChatPilot/');
    expect(launchd).toContain('com.kdnsna.daily-tech-digest');
    expect(launchd).not.toContain('com.kdnsna.wechatpilot');
  });
});
