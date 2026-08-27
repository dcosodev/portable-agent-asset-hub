# ListSkillResources200ResponseItemsInner


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**mime** | **str** |  |
**mode** | **int** |  |
**relative_path** | **str** |  |
**sha256** | **str** |  |
**size** | **int** |  |

## Example

```python
from openapi_client.models.list_skill_resources200_response_items_inner import ListSkillResources200ResponseItemsInner

# TODO update the JSON string below
json = "{}"
# create an instance of ListSkillResources200ResponseItemsInner from a JSON string
list_skill_resources200_response_items_inner_instance = ListSkillResources200ResponseItemsInner.from_json(json)
# print the JSON string representation of the object
print(ListSkillResources200ResponseItemsInner.to_json())

# convert the object into a dict
list_skill_resources200_response_items_inner_dict = list_skill_resources200_response_items_inner_instance.to_dict()
# create an instance of ListSkillResources200ResponseItemsInner from a dict
list_skill_resources200_response_items_inner_from_dict = ListSkillResources200ResponseItemsInner.from_dict(list_skill_resources200_response_items_inner_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
