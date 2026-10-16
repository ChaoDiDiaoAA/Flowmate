export const syntheticLangfuseExport = {
    connection: { baseUrl: 'https://synthetic-platform.example.invalid', publicKey: 'synthetic-lf-public', secretKey: 'synthetic-lf-secret' },
    queryProjects: async () => ({ data: [{ id: 'synthetic-project', name: 'Synthetic',
        organization: { id: 'synthetic-org', name: 'Synthetic' }, metadata: {} }] }),
};
