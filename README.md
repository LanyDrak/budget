# Budget Reader

Lecteur interactif des exports d'opérations BNP Paribas, compilés dans une Google Sheet privée.

La page ne contient aucune donnée bancaire : elle lit la Google Sheet dans le navigateur après connexion Google (OAuth), et peut y ajouter les opérations d'un nouvel export `.xls` sans créer de doublons.

## Fichiers
- `index.html` : la page
- `app.js` : lecture de la Sheet, graphiques, filtres, import des exports
- `config.js` : identifiant client Google et identifiant de la Sheet

## Mise en route Google (une seule fois)
1. Sur https://console.cloud.google.com, créer un projet « Budget Reader ».
2. « API et services » > « Bibliothèque » : activer **Google Sheets API**.
3. « Google Auth Platform » (écran de consentement) : type **Externe**, nom de l'application, e-mail d'assistance. Dans « Audience », ajouter son propre compte Gmail comme **utilisateur test**.
4. « Clients » > « Créer un client » > **Application Web**. Dans « Origines JavaScript autorisées », ajouter `https://lanydrak.github.io`.
5. Copier l'identifiant client (`…apps.googleusercontent.com`) dans `config.js`.

À la première connexion, Google affiche « Google n'a pas validé cette application » : c'est normal pour une application personnelle en mode test, cliquer sur « Continuer ».

## Format attendu de la Sheet
- Onglet `Opérations` : Date, Catégorie, Sous-catégorie, Libellé, Montant, Export du, Pointage, Commentaire
- Onglet `Soldes` : Date, Solde, Compte, Export du
