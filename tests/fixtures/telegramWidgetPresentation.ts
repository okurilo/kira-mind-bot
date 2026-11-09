/** Fictional data for visual/transport regressions, never a current forecast. */
export const compactTelegramDraft = {
    meta: { title: 'Пример прогноза' },
    components: [
        { id: 'root', component: 'Column', children: ['title', 'condition', 'current', 'periods'] },
        { id: 'title', component: 'Text', text: 'Пример прогноза', variant: 'title' },
        { id: 'condition', component: 'Text', text: 'Облачно', variant: 'caption' },
        { id: 'current', component: 'Metric', label: 'Сейчас', value: '18 °C', detail: 'Учебные данные' },
        { id: 'periods', component: 'Row', children: ['day', 'night'] },
        { id: 'day', component: 'Metric', label: 'Днём', value: '21 °C' },
        { id: 'night', component: 'Metric', label: 'Ночью', value: '13 °C' },
    ],
};
export const compactTelegramAnswer = 'Облачно, сейчас 18 °C, днём до 21 °C, ночью 13 °C. Это учебный пример.';
