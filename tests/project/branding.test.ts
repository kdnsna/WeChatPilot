import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const readProjectFile = (path: string) =>
  readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('WeChatPilot public identity', () => {
  it('uses the public brand and a portable LaunchAgent template', async () => {
    const [readme, packageText, issueConfig, launchd] = await Promise.all([
      readProjectFile('README.md'),
      readProjectFile('package.json'),
      readProjectFile('.github/ISSUE_TEMPLATE/config.yml'),
      readProjectFile('launchd/io.wechatpilot.daily-tech-digest.plist.template'),
    ]);
    const packageJson = JSON.parse(packageText) as Record<string, unknown>;

    expect(readme).toContain('# WeChatPilot');
    expect(readme).toContain('本地优先');
    expect(readme).toContain('不存在隶属、授权或背书关系');
    expect(packageJson.name).toBe('wechatpilot');
    expect(packageJson.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/kdnsna/WeChatPilot.git',
    });
    expect(issueConfig).toContain('github.com/kdnsna/WeChatPilot/');
    expect(launchd).toContain('io.wechatpilot.daily-tech-digest');
    expect(launchd).toContain('{{PROJECT_ROOT}}');
  });
});
