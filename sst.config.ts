/// <reference types="./.sst/platform/config.d.ts" />
// noinspection JSUnusedGlobalSymbols
export default $config({
  async app(input) {
    const {stage} = input;
    // octoathlete-pr default region
    const region = 'eu-west-2';
    const profile = process.env.AWS_PROFILE;
    return {
      name: 'octorouter',
      protected: ['ops'].includes(stage),
      removal: ['ops'].includes(stage) ? 'retain' : 'remove',
      home: 'aws',
      providers: {
        aws: {region: region as never, profile}
      }
    };
  },
  async run() {
    const {octoRouterInfrastructure} = await import('./infra/octorouter');
    const profile = process.env.AWS_PROFILE;
    const region = 'eu-west-2';
    console.info(`Running SST with AWS profile '${profile}' and AWS region '${region}'`);
    return octoRouterInfrastructure();
  }
});
