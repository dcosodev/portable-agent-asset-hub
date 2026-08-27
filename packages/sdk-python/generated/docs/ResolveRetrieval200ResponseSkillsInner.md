# ResolveRetrieval200ResponseSkillsInner


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**depth** | **int** |  |
**parent** | **str** |  | [optional]
**reason** | **str** |  |
**relation** | **str** |  | [optional]
**score** | **float** |  |
**skill_id** | **str** |  |
**tier** | **str** |  |
**version** | **int** |  |

## Example

```python
from openapi_client.models.resolve_retrieval200_response_skills_inner import ResolveRetrieval200ResponseSkillsInner

# TODO update the JSON string below
json = "{}"
# create an instance of ResolveRetrieval200ResponseSkillsInner from a JSON string
resolve_retrieval200_response_skills_inner_instance = ResolveRetrieval200ResponseSkillsInner.from_json(json)
# print the JSON string representation of the object
print(ResolveRetrieval200ResponseSkillsInner.to_json())

# convert the object into a dict
resolve_retrieval200_response_skills_inner_dict = resolve_retrieval200_response_skills_inner_instance.to_dict()
# create an instance of ResolveRetrieval200ResponseSkillsInner from a dict
resolve_retrieval200_response_skills_inner_from_dict = ResolveRetrieval200ResponseSkillsInner.from_dict(resolve_retrieval200_response_skills_inner_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
